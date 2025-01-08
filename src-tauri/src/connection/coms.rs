use crate::connection::connection::Connection;
use crate::connection::types::ComError;
use std::thread;
use std::time::Duration;
use tauri::AppHandle;


pub fn setup_zmq_receiver(app: AppHandle) -> Result<(), ComError> {
    thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            match Connection::new(app) {
                Ok(connection) => {
                    loop {
                        if let Err(e) = connection.handle_message().await {
                            eprintln!("Error handling message: {}", e);
                            // Add delay before retry
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
                Err(e) => eprintln!("Failed to create connection: {}", e),
            }
        });
    });

    Ok(())
}