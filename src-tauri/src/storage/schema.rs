pub const SCHEMA: &str = r#"
-- Project metadata (single row)
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config JSON NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Labels
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    is_instance BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0
);

-- Sequences (every image belongs to a sequence, even if alone)
CREATE TABLE IF NOT EXISTS sequences (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
);

-- Frames (images within sequences)
CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    frame_index INTEGER NOT NULL,
    relative_path TEXT,
    content_hash TEXT,
    embedded_data BLOB,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    reviewed BOOLEAN DEFAULT FALSE,
    UNIQUE(sequence_id, frame_index)
);

-- Annotations (per frame, per label)
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    encoding TEXT NOT NULL DEFAULT 'rle',
    mask_data BLOB NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_id)
);

-- Vector annotations (per frame, per label): bezier paths / polygons / polylines.
-- `shapes` is a JSON array of VectorShape, owned and validated by the frontend.
CREATE TABLE IF NOT EXISTS vector_annotations (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    shapes JSON NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_id)
);
CREATE TABLE IF NOT EXISTS classifications (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    selected_classes JSON NOT NULL,
    is_multilabel BOOLEAN DEFAULT FALSE,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, task_name)
);
CREATE TABLE IF NOT EXISTS text_descriptions (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_name TEXT NOT NULL,
    content TEXT NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_name)
);
CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    reference_frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    moving_frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    -- 9 floats for a 3x3 homography (row-major), JSON-encoded.
    -- NULL until fewer than 4 pairs have been placed.
    homography JSON,
    transform_type TEXT NOT NULL DEFAULT 'homography',
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reference_frame_id, moving_frame_id),
    CHECK (reference_frame_id != moving_frame_id)
);

-- Individual keypoint correspondences within a registration.
CREATE TABLE IF NOT EXISTS keypoint_pairs (
    id INTEGER PRIMARY KEY,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    -- Stable string id from the frontend (crypto.randomUUID()).
    -- Lets the frontend round-trip its own ids without remapping.
    client_uuid TEXT NOT NULL,
    -- Image-native pixel coordinates. REAL not INTEGER — sub-pixel placement
    -- happens when the user drags points around at high zoom.
    ref_x REAL NOT NULL,
    ref_y REAL NOT NULL,
    moving_x REAL NOT NULL,
    moving_y REAL NOT NULL,
    -- For stable ordering in the UI list (matches insertion order).
    sort_order INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(registration_id, client_uuid)
);


CREATE INDEX IF NOT EXISTS idx_frames_sequence ON frames(sequence_id);
CREATE INDEX IF NOT EXISTS idx_annotations_frame ON annotations(frame_id);
CREATE INDEX IF NOT EXISTS idx_vector_annotations_frame ON vector_annotations(frame_id);
CREATE INDEX IF NOT EXISTS idx_classifications_frame ON classifications(frame_id);
CREATE INDEX IF NOT EXISTS idx_text_descriptions_frame ON text_descriptions(frame_id);
CREATE INDEX IF NOT EXISTS idx_registrations_sequence
    ON registrations(sequence_id);
CREATE INDEX IF NOT EXISTS idx_registrations_ref_frame
    ON registrations(reference_frame_id);
CREATE INDEX IF NOT EXISTS idx_keypoint_pairs_registration
    ON keypoint_pairs(registration_id);
"#;

/// v1 -> v2: vector annotations (bezier paths / polygons / polylines).
/// `CREATE ... IF NOT EXISTS`, so it's a no-op on fresh databases that already
/// got the table from the baseline SCHEMA.
pub const MIGRATION_V2: &str = r#"
CREATE TABLE IF NOT EXISTS vector_annotations (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    shapes JSON NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_vector_annotations_frame
    ON vector_annotations(frame_id);
"#;