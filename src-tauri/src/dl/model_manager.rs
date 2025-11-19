use std::path::PathBuf;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;

const HUGGINGFACE_BASE_URL: &str = "https://huggingface.co";

pub struct ModelConfig {
    pub repo_id: String,
    pub filename: String,
    pub cache_subdir: String,
    pub expected_size: Option<u64>, // Optional: for validation
}

impl ModelConfig {
    pub fn encoder() -> Self {
        Self {
            repo_id: "ClementP/DoodleMaskSAM".to_string(),
            filename: "encoder.onnx".to_string(),
            cache_subdir: "maskedMedSAM".to_string(),
            expected_size: Some(367582662), // The size from your logs
        }
    }

    pub fn decoder() -> Self {
        Self {
            repo_id: "ClementP/DoodleMaskSAM".to_string(),
            filename: "decoder.onnx".to_string(),
            cache_subdir: "maskedMedSAM".to_string(),
            expected_size: None, // Update this if you know the size
        }
    }
}

pub async fn ensure_model_cached(
    app: &tauri::AppHandle,
    config: &ModelConfig,
) -> Result<PathBuf, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let models_dir = cache_dir.join("models").join(&config.cache_subdir);
    tokio::fs::create_dir_all(&models_dir)
        .await
        .map_err(|e| format!("Failed to create models directory: {}", e))?;

    let model_path = models_dir.join(&config.filename);

    // Check if model exists and validate it
    if model_path.exists() {
        println!("Model found at: {:?}", model_path);

        // Validate file size if expected size is provided
        if let Some(expected_size) = config.expected_size {
            let metadata = tokio::fs::metadata(&model_path)
                .await
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;

            if metadata.len() != expected_size {
                println!(
                    "Model file size mismatch! Expected: {}, Got: {}. Re-downloading...",
                    expected_size,
                    metadata.len()
                );
                // Delete corrupted file
                tokio::fs::remove_file(&model_path)
                    .await
                    .map_err(|e| format!("Failed to remove corrupted file: {}", e))?;
            } else {
                println!("Model already cached at: {:?}", model_path);
                return Ok(model_path);
            }
        } else {
            println!("Model already cached at: {:?}", model_path);
            return Ok(model_path);
        }
    }

    println!("Model not found in cache, downloading...");
    download_model(app, config, &model_path).await?;

    // Verify after download
    if let Some(expected_size) = config.expected_size {
        let metadata = tokio::fs::metadata(&model_path)
            .await
            .map_err(|e| format!("Failed to read downloaded file metadata: {}", e))?;

        if metadata.len() != expected_size {
            return Err(format!(
                "Downloaded file size mismatch! Expected: {}, Got: {}",
                expected_size,
                metadata.len()
            ));
        }
    }

    Ok(model_path)
}

async fn download_model(
    app: &tauri::AppHandle,
    config: &ModelConfig,
    output_path: &PathBuf,
) -> Result<(), String> {
    let url = format!(
        "{}/{}/resolve/main/{}",
        HUGGINGFACE_BASE_URL, config.repo_id, config.filename
    );

    println!("Downloading from: {}", url);

    let client = reqwest::Client::builder()
        .user_agent("tauri-app")
        .timeout(std::time::Duration::from_secs(300)) // 5 minute timeout
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}. URL: {}",
            response.status(),
            url
        ));
    }

    let total_size = response
        .content_length()
        .ok_or("Failed to get content length")?;

    println!("Total size: {} bytes", total_size);

    // Create temporary file
    let temp_path = output_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;

    // Stream download with progress
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_progress_log = 0u64;

    use futures_util::StreamExt;
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Error downloading chunk: {}", e))?;

        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Error writing to file: {}", e))?;

        downloaded += chunk.len() as u64;
        let progress = (downloaded as f64 / total_size as f64) * 100.0;

        // Log every 10% or at completion
        if downloaded - last_progress_log >= total_size / 10 || downloaded == total_size {
            println!(
                "Download progress: {:.2}% ({}/{})",
                progress, downloaded, total_size
            );
            last_progress_log = downloaded;

            let _ = app.emit(
                "download-progress",
                serde_json::json!({
                    "filename": config.filename,
                    "progress": progress,
                    "downloaded": downloaded,
                    "total": total_size
                }),
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;
    drop(file);

    // Verify download completed
    if downloaded != total_size {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(format!(
            "Download incomplete! Expected: {}, Downloaded: {}",
            total_size, downloaded
        ));
    }

    // Rename temp file to final name
    tokio::fs::rename(&temp_path, output_path)
        .await
        .map_err(|e| format!("Failed to rename file: {}", e))?;

    println!("Download complete: {:?}", output_path);
    Ok(())
}
