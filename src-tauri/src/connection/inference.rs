use std::sync::Mutex;
use std::time::Duration;

use image::GenericImageView;
use serde::de::DeserializeOwned;

use crate::connection::{
  request::{ ImagePayload, PingReply, Request, Status },
  types::ComError,
};
use crate::commands::frame::read_frame_bytes;
use crate::storage::DbState;

/// A frame as Python functions receive it: 8-bit RGB, as the editor shows
/// it. A frame deeper than 8 bits or with several channels (a microscopy
/// import) is rendered through the Channels panel's settings, so each channel
/// lands in the colours set there; decoding its bytes as an ordinary image
/// would give only the first channel, reduced to 8 bits.
pub fn load_frame_as_payload(db: &DbState, frame_id: i64) -> Result<ImagePayload, ComError> {
  let (_meta, bytes) = read_frame_bytes(db, frame_id).map_err(|e| ComError::Other(e.to_string()))?;

  let img = crate::commands::pixels
    ::frame_picture(db, frame_id, &bytes, 0)
    .map_err(|e| ComError::Other(format!("decode failed: {e}")))?;

  let (w, h) = img.dimensions();
  let rgb = img.to_rgb8();
  Ok(ImagePayload {
    buf: rgb.into_raw(),
    shape: vec![h as usize, w as usize, 3],
    dtype: "uint8".to_string(),
  })
}

/// How long the peer gets to answer.
pub mod timeout {
  use std::time::Duration;
  /// Background discovery.
  pub const PROBE: Duration = Duration::from_millis(400);
  pub const PING: Duration = Duration::from_secs(3);
  pub const TRANSFER: Duration = Duration::from_secs(60);
  pub const KEYPOINTS: Duration = Duration::from_secs(30);
  /// The first call often loads model weights.
  pub const SEGMENT: Duration = Duration::from_secs(300);
  pub const SEQUENCE: Duration = Duration::from_secs(3600);
}

/// Where the user's Python server is. Holds no socket: every exchange opens
/// its own [`Channel`], because a REQ socket that timed out can never send
/// again.
pub struct InferenceClient {
  ctx: zmq::Context,
  endpoint: Mutex<Option<String>>,
}

impl InferenceClient {
  pub fn new() -> Self {
    Self {
      ctx: zmq::Context::new(),
      endpoint: Mutex::new(None),
    }
  }

  pub fn connect(&self, host: &str, port: u16, wait: Duration) -> Result<PingReply, ComError> {
    let endpoint = format!("tcp://{host}:{port}");
    let reply: PingReply = Channel::open(&self.ctx, &endpoint)?.call(&Request::Ping, wait)?;
    *self.endpoint.lock().unwrap() = Some(endpoint);
    Ok(reply.with_legacy_functions())
  }

  pub fn channel(&self) -> Result<Channel, ComError> {
    let endpoint = self.endpoint.lock().unwrap().clone();
    let endpoint = endpoint.ok_or_else(|| ComError::Other("not connected".into()))?;
    Channel::open(&self.ctx, &endpoint)
  }
}

pub struct Channel {
  socket: zmq::Socket,
}

impl Channel {
  fn open(ctx: &zmq::Context, endpoint: &str) -> Result<Self, ComError> {
    let socket = ctx.socket(zmq::REQ)?;
    socket.set_sndtimeo(5_000)?;
    socket.set_linger(0)?;
    socket.connect(endpoint)?;
    Ok(Self { socket })
  }

  /// Send `req` and decode the reply; the peer's `ok: false` becomes an error.
  /// After an error the channel is unusable.
  pub fn call<T: DeserializeOwned>(&self, req: &Request, wait: Duration) -> Result<T, ComError> {
    let buf = rmp_serde::to_vec_named(req).map_err(|e| ComError::Other(e.to_string()))?;
    // Saturated, never truncated: a wrapped -1 means "block forever" to libzmq.
    self.socket.set_rcvtimeo(i32::try_from(wait.as_millis()).unwrap_or(i32::MAX))?;
    match self.socket.send(buf, 0) {
      Ok(()) => {}
      Err(zmq::Error::EAGAIN) => return Err(ComError::NotListening),
      Err(e) => return Err(e.into()),
    }
    let reply = match self.socket.recv_bytes(0) {
      Ok(reply) => reply,
      Err(zmq::Error::EAGAIN) => return Err(ComError::NoReply),
      Err(e) => return Err(e.into()),
    };

    let status: Status = decode(&reply)?;
    if !status.ok {
      return Err(ComError::Peer(status.error.unwrap_or_default()));
    }
    decode(&reply)
  }

  /// For replies that carry nothing beyond `ok`.
  pub fn send(&self, req: &Request, wait: Duration) -> Result<(), ComError> {
    self.call::<serde::de::IgnoredAny>(req, wait).map(|_| ())
  }
}

fn decode<T: DeserializeOwned>(buf: &[u8]) -> Result<T, ComError> {
  rmp_serde::from_slice(buf).map_err(|e| ComError::Other(format!("decode failed: {e}")))
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::connection::request::{ FindKeypointsReply, MaskPayloads, MasksReply, SeqRunReply };

  fn image(red: u8) -> ImagePayload {
    // 2 × 3 RGB, first pixel `red`, the rest black.
    let mut buf = vec![0u8; 2 * 3 * 3];
    buf[0] = red;
    ImagePayload { buf, shape: vec![2, 3, 3], dtype: "uint8".into() }
  }

  #[test]
  fn a_multi_channel_frame_is_sent_as_the_editor_shows_it() {
    use crate::pixels::display::{ ChannelDisplay, DisplaySettings };
    use tiff::encoder::{ colortype::Gray16, TiffEncoder };

    // Two 12-bit channels: the first shown in green, the second in red.
    let mut tiff = std::io::Cursor::new(Vec::new());
    {
      let mut enc = TiffEncoder::new(&mut tiff).unwrap();
      enc.write_image::<Gray16>(2, 1, &[4000, 0]).unwrap();
      enc.write_image::<Gray16>(2, 1, &[0, 4000]).unwrap();
    }
    let conn = crate::storage::queries::create_database(std::path::Path::new(":memory:")).unwrap();
    conn
      .execute_batch(
        "INSERT OR REPLACE INTO project (id, config) VALUES (1, json_object('input_folder', NULL));
         INSERT INTO sequences (id, name) VALUES (1, 's');",
      )
      .unwrap();
    conn
      .execute(
        "INSERT INTO frames (id, sequence_id, frame_index, width, height, embedded_data)
         VALUES (7, 1, 0, 2, 1, ?1)",
        [tiff.get_ref()],
      )
      .unwrap();
    let channel = |color: &str| ChannelDisplay {
      name: None, visible: true, color: color.into(), min: 0.0, max: 4000.0, gamma: 1.0,
    };
    let settings = DisplaySettings { channels: vec![channel("#00ff00"), channel("#ff0000")] };
    crate::storage::queries
      ::save_display_settings(&conn, 1, Some(&serde_json::to_string(&settings).unwrap()))
      .unwrap();
    let db = DbState::new();
    db.set(conn);

    let payload = load_frame_as_payload(&db, 7).unwrap();
    assert_eq!(payload.shape, vec![1, 2, 3]);
    // Pixel 0: channel 1 at full, in green. Pixel 1: channel 2, in red.
    assert_eq!(payload.buf, vec![0, 255, 0, 255, 0, 0]);
  }

  /// Against a live `didascalie.com` server; see `DIDASCALIE_TEST_PORT`.
  #[test]
  #[ignore = "needs a running Python server"]
  fn talks_to_python() {
    let port: u16 = std::env::var("DIDASCALIE_TEST_PORT").unwrap().parse().unwrap();
    let client = InferenceClient::new();
    let ping = client.connect("127.0.0.1", port, timeout::PING).unwrap();
    assert_eq!(ping.protocol_version, 2);
    assert_eq!(ping.registered, vec!["match"]);
    let bright = ping.functions.iter().find(|f| f.name == "bright").unwrap();
    assert_eq!((bright.kind.as_str(), bright.doc.as_str()), ("seg", "Thresholds the red channel."));
    assert_eq!(bright.wants, vec!["masks", "active_label"]);

    let labels = vec!["a".to_string(), "b".to_string()];
    let chan = client.channel().unwrap();

    let kp: FindKeypointsReply = chan
      .call(&Request::FindKeypoints { name: "match".into(), r#ref: image(0), mov: image(0), existing: vec![] }, timeout::PING)
      .unwrap();
    assert_eq!(kp.pairs, vec![[[1.0, 2.0], [3.0, 4.0]]]);

    let mut masks = MaskPayloads::new();
    masks.insert("b".into(), ImagePayload::mask(vec![9, 0, 0, 0, 0, 0], 3, 2));
    let seg: MasksReply = chan
      .call(&Request::Segment {
        name: "bright".into(), image: image(200), labels: labels.clone(),
        active_label: Some("b".into()), frame_index: Some(0), masks: Some(masks), args: Default::default(), frame_name: None,
      }, timeout::PING)
      .unwrap();
    assert_eq!(seg.unknown, vec!["zzz"]);
    assert_eq!(seg.masks.len(), 1);
    assert_eq!(seg.masks[0].label.as_deref(), Some("a"));
    assert_eq!((seg.masks[0].buf.clone(), seg.masks[0].shape.clone(), seg.masks[0].binary), (vec![1, 0, 0, 0, 0, 0], vec![2, 3], true));

    let single: MasksReply = chan
      .call(&Request::Segment {
        name: "single".into(), image: image(0), labels: labels.clone(),
        active_label: None, frame_index: None, masks: None, args: Default::default(), frame_name: None,
      }, timeout::PING)
      .unwrap();
    assert_eq!((single.masks[0].label.clone(), single.masks[0].buf[0], single.masks[0].binary), (None, 3, false));

    chan.send(&Request::SeqBegin { name: "track".into(), n_frames: 3, labels: labels.clone(), active_label: Some("a".into()), frame_index: Some(1), args: Default::default(), frame_name: None }, timeout::PING).unwrap();
    for (index, red) in [0u8, 200, 0].into_iter().enumerate() {
      chan.send(&Request::SeqFrame { index, image: image(red), masks: None }, timeout::PING).unwrap();
    }
    let run: SeqRunReply = chan.call(&Request::SeqRun, timeout::PING).unwrap();
    assert!(run.unknown.is_empty());
    let sums: Vec<u8> = (0..3)
      .map(|index| {
        let r: MasksReply = chan.call(&Request::SeqResult { index }, timeout::PING).unwrap();
        assert_eq!(r.masks[0].label, None);
        r.masks[0].buf.iter().sum()
      })
      .collect();
    assert_eq!(sums, vec![0, 1, 0]);
    chan.send(&Request::SeqEnd, timeout::PING).unwrap();

    // A Python exception comes back as the peer's own message.
    let err = chan
      .call::<MasksReply>(&Request::Segment {
        name: "boom".into(), image: image(0), labels, active_label: None, frame_index: None, masks: None, args: Default::default(), frame_name: None,
      }, timeout::PING)
      .unwrap_err();
    assert_eq!(err.to_string(), "RuntimeError: model exploded");

    // Nobody listening: a probe gives up quickly.
    let started = std::time::Instant::now();
    assert!(matches!(client.connect("127.0.0.1", 1, timeout::PROBE), Err(ComError::NoReply)));
    assert!(started.elapsed() < Duration::from_secs(2));
    // A failed connect leaves the working endpoint in place.
    assert!(client.channel().unwrap().send(&Request::Ping, timeout::PING).is_ok());
  }

  /// Needs `scaled(image, gain=Float(1, max=10), n=Int(1), on=Boolean(),
  /// mode=Enum(["a", "b"]))`, returning `gain * n + on + (mode == "b")` as a
  /// constant H × W mask of integers.
  #[test]
  #[ignore = "needs a running Python server"]
  fn passes_arguments_to_python() {
    use crate::connection::request::{ ArgValues, MasksReply };

    let port: u16 = std::env::var("DIDASCALIE_TEST_PORT").unwrap().parse().unwrap();
    let client = InferenceClient::new();
    let ping = client.connect("127.0.0.1", port, timeout::PING).unwrap();
    let scaled = ping.functions.iter().find(|f| f.name == "scaled").unwrap();
    let kinds: Vec<&str> = scaled.params.iter().map(|p| p.kind.as_str()).collect();
    assert_eq!(kinds, ["float", "int", "bool", "enum"]);
    assert_eq!(scaled.params[0].max, Some(10.0));
    assert_eq!(scaled.params[3].choices, ["a", "b"]);

    let run = |args: serde_json::Value| {
      let args: ArgValues = serde_json::from_value(args).unwrap();
      client.channel().unwrap().call::<MasksReply>(&Request::Segment {
        name: "scaled".into(), image: image(0), labels: vec!["a".into()],
        active_label: Some("a".into()), frame_index: None, masks: None, args, frame_name: Some("sub/a.png".into()),
      }, timeout::PING)
    };
    let reply = run(serde_json::json!({ "gain": 2.5, "n": 2, "on": true, "mode": "b" })).unwrap();
    assert_eq!(reply.masks[0].buf[0], 7);
    assert_eq!(run(serde_json::json!({})).unwrap().masks[0].buf[0], 1);
    let refused = run(serde_json::json!({ "gain": 11 })).unwrap_err();
    assert!(refused.to_string().contains("above the maximum"), "{refused}");
  }

  /// Needs `named(image, frame_name)`, returning
  /// `Result(message=f"Saved {frame_name}")`.
  #[test]
  #[ignore = "needs a running Python server"]
  fn passes_the_frame_name_and_receives_a_message() {
    use crate::connection::request::MasksReply;

    let port: u16 = std::env::var("DIDASCALIE_TEST_PORT").unwrap().parse().unwrap();
    let client = InferenceClient::new();
    client.connect("127.0.0.1", port, timeout::PING).unwrap();
    let reply: MasksReply = client.channel().unwrap().call(&Request::Segment {
      name: "named".into(), image: image(0), labels: vec!["a".into()], active_label: None,
      frame_index: None, masks: None, args: Default::default(),
      frame_name: Some("sub/a.png".into()),
    }, timeout::PING).unwrap();
    assert!(reply.masks.is_empty());
    assert_eq!(reply.message.as_deref(), Some("Saved sub/a.png"));
  }
}
