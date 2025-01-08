use tauri::{ AppHandle, Emitter };
use lazy_static::lazy_static;
use crate::connection::types::{ ComError, Command, Response };
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex; // Switch to parking_lot for better debugging
use tokio::sync::oneshot;
use uuid::Uuid;
use std::time::Duration;
use serde::{ Deserialize, Serialize };

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EventPayload<T: Clone> {
  event_id: Uuid,
  data: T,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EventAck {
  event_id: Uuid,
  success: bool,
  error: Option<String>,
}
pub struct EventHandler {
    pending_events: HashMap<Uuid, oneshot::Sender<EventAck>>,
}

// Make EVENT_HANDLER static and wrapped in Arc<Mutex>
lazy_static! {
    static ref EVENT_HANDLER: Arc<Mutex<EventHandler>> = Arc::new(Mutex::new(EventHandler::new()));
}

impl EventHandler {
    pub fn new() -> Self {
        Self {
            pending_events: HashMap::new(),
        }
    }

    pub fn register_event(&mut self, event_id: Uuid, sender: oneshot::Sender<EventAck>) {
        println!("Registering event: {event_id}");
        self.pending_events.insert(event_id, sender);
        println!("Events in handler: {:?}", self.pending_events.keys().collect::<Vec<_>>());
    }
}
pub struct Connection {
  socket: zmq::Socket,
  app: Arc<AppHandle>,
}

impl Connection {
  pub fn new(app: AppHandle) -> Result<Self, ComError> {
    let context = zmq::Context::new();
    let socket = context.socket(zmq::REP)?;
    socket.set_immediate(true)?; // Add immediate mode

    match socket.bind("tcp://127.0.0.1:5555") {
      Ok(_) => {
        println!("ZMQ socket bound to localhost:5555");
        Ok(Self {
          socket,
          app: Arc::new(app),
        })
      }
      Err(e) => {
        eprintln!("Failed to bind ZMQ socket to localhost: {}", e);
        Err(ComError::ZmqError(e))
      }
    }
  }

  async fn emit_and_wait<T: Serialize + Clone>(&self, event: &str, payload: T) -> Result<(), ComError> {
    let event_id = Uuid::new_v4();
    println!("Creating event: {event_id}");
    
    let (tx, rx) = oneshot::channel();
    {
        let mut handler = EVENT_HANDLER.lock();
        handler.register_event(event_id, tx);
    }

    let event_payload = EventPayload {
        event_id,
        data: payload,
    };
    self.app.emit(event, event_payload)?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(ack)) if ack.success => Ok(()),
        Ok(Ok(ack)) => Err(ComError::EventError(ack.error.unwrap_or_default())),
        _ => {
            println!("Timeout waiting for event: {event_id}");
            let mut handler = EVENT_HANDLER.lock();
            handler.pending_events.remove(&event_id);
            Err(ComError::Timeout)
        }
    }
}

  async fn process_command(
    &self,
    command: Command
  ) -> Result<Response<serde_json::Value>, ComError> {
    match command {
      Command::CreateProject(config) => {
        self.emit_and_wait("create_project", config).await?;
        Ok(Response {
          success: true,
          data: None,
          error: None,
        })
      }
      Command::LoadImage(config) => {
        self.emit_and_wait("load_image", config).await?;
        Ok(Response {
          success: true,
          data: None,
          error: None,
        })
      }
      Command::GetImages => {
        // Implement get images logic
        Ok(Response {
          success: true,
          data: Some(serde_json::json!([])),
          error: None,
        })
      }
      Command::NextImage => {
        self.emit_and_wait("next_image", ()).await?;
        Ok(Response {
          success: true,
          data: None,
          error: None,
        })
      }
      Command::PreviousImage => {
        self.emit_and_wait("previous_image", ()).await?;
        Ok(Response {
          success: true,
          data: None,
          error: None,
        })
      }
    }
  }

  pub async fn handle_message(&self) -> Result<(), ComError> {
    // Receive one message
    let msg = match self.socket.recv_bytes(0) {
      Ok(m) => m,
      Err(zmq::Error::EAGAIN) => {
        // No message ready - handle gracefully, e.g. return Ok
        return Ok(());
      }
      Err(e) => {
        return Err(ComError::ZmqError(e));
      }
    };

    // Process the message
    let response = match serde_json::from_slice::<Command>(&msg) {
      Ok(command) => {
        // If parse OK, pass to process_command
        match self.process_command(command).await {
          Ok(resp) => resp,
          Err(e) => {
            eprintln!("Command error: {e}");
            Response {
              success: false,
              data: None,
              error: Some(e.to_string()),
            }
          }
        }
      }
      Err(e) => {
        // If deserialization fails, still respond
        eprintln!("JSON parse error: {e}");
        Response {
          success: false,
          data: None,
          error: Some("Invalid request".to_string()),
        }
      }
    };

    // Send final response (success or error)
    let response_bytes = serde_json::to_vec(&response)?;
    match self.socket.send(response_bytes, 0) {
      Ok(_) => Ok(()),
      Err(e) => Err(ComError::ZmqError(e)),
    }
  }
}

impl Drop for Connection {
  fn drop(&mut self) {
    // Socket will be automatically closed when dropped
  }
}

// Tauri command signature
#[tauri::command]
pub fn event_processed(id: String, success: bool, error: Option<String>) {
    println!("Starting event_processed for id: {id}");
    
    let parsed = match Uuid::parse_str(&id) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("Invalid UUID string: {e}");
            return;
        }
    };

    let mut handler = EVENT_HANDLER.lock();
    println!("Events in handler: {:?}", handler.pending_events.keys().collect::<Vec<_>>());
    
    if let Some(sender) = handler.pending_events.remove(&parsed) {
        println!("Found sender for {parsed}, sending ack");
        if let Err(e) = sender.send(EventAck {
            event_id: parsed,
            success,
            error,
        }) {
            eprintln!("Failed to send ack: {:?}", e);
        }
    } else {
        println!("No sender found for {parsed}");
    }
}
