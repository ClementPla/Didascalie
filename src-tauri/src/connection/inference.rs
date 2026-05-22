// src-tauri/src/connection/inference.rs
use image::GenericImageView;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::connection::{
  request::{ FindKeypointsReply, ImagePayload, PingReply, Request },
  types::ComError,
};
use crate::commands::frame::read_frame_bytes;
use crate::storage::DbState;

pub fn load_frame_as_payload(db: &DbState, frame_id: i64) -> Result<ImagePayload, ComError> {
  let (_meta, bytes) = read_frame_bytes(db, frame_id).map_err(|e| ComError::Other(e.to_string()))?;

  let img = image
    ::load_from_memory(&bytes)
    .map_err(|e| ComError::Other(format!("decode failed: {e}")))?;

  let (w, h) = img.dimensions();
  let rgb = img.to_rgb8();
  Ok(ImagePayload {
    buf: rgb.into_raw(),
    shape: vec![h as usize, w as usize, 3],
    dtype: "uint8".to_string(),
  })
}

pub struct InferenceClient {
  ctx: zmq::Context,
  socket: Mutex<Option<zmq::Socket>>,
  endpoint: Mutex<Option<String>>,
}

impl InferenceClient {
  pub fn new() -> Self {
    Self {
      ctx: zmq::Context::new(),
      socket: Mutex::new(None),
      endpoint: Mutex::new(None),
    }
  }

  pub async fn connect(&self, host: &str, port: u16) -> Result<(), ComError> {
    let endpoint = format!("tcp://{host}:{port}");
    let sock = self.ctx.socket(zmq::REQ)?;
    sock.set_rcvtimeo(30_000)?; // 30s for inference
    sock.set_sndtimeo(5_000)?;
    sock.set_linger(0)?;
    sock.connect(&endpoint)?;

    let mut s = self.socket.lock().await;
    *s = Some(sock);
    *self.endpoint.lock().await = Some(endpoint);
    Ok(())
  }

  pub async fn ping(&self) -> Result<PingReply, ComError> {
    let buf = self.request(&Request::Ping).await?;
    rmp_serde
      ::from_slice::<PingReply>(&buf)
      .map_err(|e| ComError::Other(format!("decode failed: {e}")))
  }
  pub async fn find_keypoints(
    &self,
    name: &str,
    ref_img: ImagePayload,
    mov_img: ImagePayload,
    existing: Vec<[[f64; 2]; 2]>
  ) -> Result<Vec<[[f64; 2]; 2]>, ComError> {
    let req = Request::FindKeypoints {
      name: name.into(),
      r#ref: ref_img,
      mov: mov_img,
      existing,
    };
    let reply: FindKeypointsReply = self.request(&req).await.and_then(decode)?;
    if !reply.ok {
      return Err(ComError::EventError(reply.error.unwrap_or_default()));
    }
    Ok(reply.pairs)
  }

  async fn request(&self, req: &Request) -> Result<Vec<u8>, ComError> {
    let buf = rmp_serde::to_vec_named(req).map_err(|e| ComError::Other(e.to_string()))?;
    let sock_guard = self.socket.lock().await;
    let sock = sock_guard.as_ref().ok_or_else(|| ComError::Other("not connected".into()))?;
    sock.send(buf, 0)?;
    let reply = sock.recv_bytes(0)?;
    Ok(reply)
  }
}

fn decode<T: for<'de> Deserialize<'de>>(buf: Vec<u8>) -> Result<T, ComError> {
  rmp_serde::from_slice(&buf).map_err(|e| ComError::Other(e.to_string()))
}
