use serde::{Serialize, Deserialize};
use tauri::State;
use crate::connection::inference::InferenceClient;
use crate::connection::request::PingReply;
use crate::storage::DbState;
use crate::utils::error::Result;
use crate::utils::AppError;
use crate::connection::inference::load_frame_as_payload;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeypointPair {
    /// Stable UUID assigned by the frontend.
    pub client_uuid: String,
    pub ref_x: f64,
    pub ref_y: f64,
    pub moving_x: f64,
    pub moving_y: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationData {
    pub reference_frame_id: i64,
    pub moving_frame_id: i64,
    /// 9 floats for a 3x3 homography (row-major), or null if no fit yet.
    pub homography: Option<[f64; 9]>,
    pub transform_type: String,
    pub pairs: Vec<KeypointPair>,
}

/// One registration case in a sequence: a (reference, moving) frame pair with a
/// summary of its state. A sequence can hold many, and a frame may appear in
/// several (as reference and/or moving).
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationSummary {
    pub reference_frame_id: i64,
    pub moving_frame_id: i64,
    pub transform_type: String,
    pub has_homography: bool,
    pub pair_count: i64,
}

/// List every registration case stored for a sequence.
#[tauri::command]
pub fn list_registrations(
    db: State<DbState>,
    sequence_id: i64,
) -> Result<Vec<RegistrationSummary>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT r.reference_frame_id,
                    r.moving_frame_id,
                    r.transform_type,
                    (r.homography IS NOT NULL AND r.homography != 'null') AS has_homography,
                    COUNT(k.id) AS pair_count
             FROM registrations r
             LEFT JOIN keypoint_pairs k ON k.registration_id = r.id
             WHERE r.sequence_id = ?1
             GROUP BY r.id
             ORDER BY r.id",
        )?;
        let rows = stmt
            .query_map([sequence_id], |row| {
                Ok(RegistrationSummary {
                    reference_frame_id: row.get(0)?,
                    moving_frame_id: row.get(1)?,
                    transform_type: row.get(2)?,
                    has_homography: row.get::<_, i64>(3)? != 0,
                    pair_count: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
}

#[tauri::command]
pub fn save_registration(
    db: State<DbState>,
    sequence_id: i64,
    data: RegistrationData,
) -> Result<()> {
    db.with_conn(|conn| {
        let homography_json = match &data.homography {
            Some(h) => serde_json::to_string(h)
                .map_err(|e| AppError::Generic(format!("Failed to serialize homography: {}", e)))?,
            None => "null".to_string(),
        };

        // Upsert the registration row.
        conn.execute(
            "INSERT INTO registrations
                (sequence_id, reference_frame_id, moving_frame_id, homography, transform_type, modified_at)
             VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
             ON CONFLICT(reference_frame_id, moving_frame_id)
             DO UPDATE SET
                homography = excluded.homography,
                transform_type = excluded.transform_type,
                modified_at = CURRENT_TIMESTAMP",
            (sequence_id, data.reference_frame_id, data.moving_frame_id,
             &homography_json, &data.transform_type),
        )?;

        // Get the registration_id (either freshly inserted or pre-existing).
        let registration_id: i64 = conn.query_row(
            "SELECT id FROM registrations
             WHERE reference_frame_id = ?1 AND moving_frame_id = ?2",
            (data.reference_frame_id, data.moving_frame_id),
            |row| row.get(0),
        )?;

        // Replace-all strategy for pairs: clear the existing pairs for this
        // registration, then insert the current set. Simpler than diffing
        // and good enough — keypoint sets are small (< 100 typically).
        conn.execute(
            "DELETE FROM keypoint_pairs WHERE registration_id = ?1",
            [registration_id],
        )?;

        for (idx, pair) in data.pairs.iter().enumerate() {
            conn.execute(
                "INSERT INTO keypoint_pairs
                    (registration_id, client_uuid,
                     ref_x, ref_y, moving_x, moving_y,
                     sort_order, modified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)",
                (registration_id, &pair.client_uuid,
                 pair.ref_x, pair.ref_y, pair.moving_x, pair.moving_y,
                 idx as i64),
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn load_registration(
    db: State<DbState>,
    reference_frame_id: i64,
    moving_frame_id: i64,
) -> Result<Option<RegistrationData>> {
    db.with_conn(|conn| {
        // Look up the registration row.
        let reg_row: Option<(i64, String, String)> = conn
            .query_row(
                "SELECT id, COALESCE(homography, 'null') as homography, transform_type
                 FROM registrations
                 WHERE reference_frame_id = ?1 AND moving_frame_id = ?2",
                (reference_frame_id, moving_frame_id),
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();

        let Some((reg_id, homography_json, transform_type)) = reg_row else {
            return Ok(None);
        };

        let homography: Option<[f64; 9]> = if homography_json == "null" {
            None
        } else {
            serde_json::from_str(&homography_json)
                .map_err(|e| AppError::Generic(format!("Bad homography JSON: {}", e)))?
        };

        // Load all pairs for this registration.
        let mut stmt = conn.prepare(
            "SELECT client_uuid, ref_x, ref_y, moving_x, moving_y
             FROM keypoint_pairs
             WHERE registration_id = ?1
             ORDER BY sort_order",
        )?;
        let pairs = stmt.query_map([reg_id], |row| {
            Ok(KeypointPair {
                client_uuid: row.get(0)?,
                ref_x: row.get(1)?,
                ref_y: row.get(2)?,
                moving_x: row.get(3)?,
                moving_y: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

        Ok(Some(RegistrationData {
            reference_frame_id,
            moving_frame_id,
            homography,
            transform_type,
            pairs,
        }))
    })
}

#[tauri::command]
pub fn delete_registration(
    db: State<DbState>,
    reference_frame_id: i64,
    moving_frame_id: i64,
) -> Result<()> {
    db.with_conn(|conn| {
        // Cascade will delete the keypoint pairs.
        conn.execute(
            "DELETE FROM registrations
             WHERE reference_frame_id = ?1 AND moving_frame_id = ?2",
            (reference_frame_id, moving_frame_id),
        )?;
        Ok(())
    })
}

#[tauri::command]
pub async fn find_keypoints_prefill(
    name: String,
    ref_frame_id: i64,
    mov_frame_id: i64,
    existing: Vec<[[f64; 2]; 2]>,
    db: State<'_, DbState>,
    client: State<'_, InferenceClient>,
) -> std::result::Result<Vec<[[f64; 2]; 2]>, AppError> {
    let ref_img = load_frame_as_payload(&db, ref_frame_id)
        .map_err(|e| AppError::Generic(e.to_string()))?;
    let mov_img = load_frame_as_payload(&db, mov_frame_id)
        .map_err(|e| AppError::Generic(e.to_string()))?;
    client
        .find_keypoints(&name, ref_img, mov_img, existing)
        .await
        .map_err(|e| AppError::Generic(e.to_string()))
}

#[tauri::command]
pub async fn inference_connect(
    host: String, port: u16,
    client: State<'_, InferenceClient>,
) -> Result<PingReply> {
    client.connect(&host, port).await?;
    client.ping().await.map_err(Into::into)
}