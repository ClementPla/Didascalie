use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// The ZMQ wire format shared with `didascalie.com` on the Python side: field
// names must match.

#[derive(Serialize)]
pub struct ImagePayload {
    #[serde(with = "serde_bytes")]
    pub buf: Vec<u8>,
    pub shape: Vec<usize>,
    pub dtype: String,         // "uint8" | "uint16" | "float32"
}

impl ImagePayload {
    /// A `height × width` uint8 label mask.
    pub fn mask(buf: Vec<u8>, width: u32, height: u32) -> Self {
        Self { buf, shape: vec![height as usize, width as usize], dtype: "uint8".into() }
    }
}

/// Current masks by label name. Labels with nothing drawn are left out.
pub type MaskPayloads = BTreeMap<String, ImagePayload>;

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Ping,
    FindKeypoints {
        name: String,
        #[serde(rename = "ref")]
        r#ref: ImagePayload,
        mov: ImagePayload,
        existing: Vec<[[f64; 2]; 2]>,
    },
    Segment {
        name: String,
        image: ImagePayload,
        labels: Vec<String>,
        active_label: Option<String>,
        frame_index: Option<usize>,
        #[serde(skip_serializing_if = "Option::is_none")]
        masks: Option<MaskPayloads>,
    },
    // A sequence goes over as one message per frame: begin, the frames, run,
    // then one result per frame.
    SeqBegin {
        name: String,
        n_frames: usize,
        labels: Vec<String>,
        active_label: Option<String>,
        frame_index: Option<usize>,
    },
    SeqFrame {
        index: usize,
        image: ImagePayload,
        #[serde(skip_serializing_if = "Option::is_none")]
        masks: Option<MaskPayloads>,
    },
    SeqRun,
    SeqResult {
        index: usize,
    },
    SeqEnd,
}

/// What every reply carries. Decoded first, so a failure need not match the
/// shape of the success reply.
#[derive(Debug, Deserialize)]
pub struct Status {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    /// "keypoints" | "seg" | "sequence_seg"
    pub kind: String,
    #[serde(default)]
    pub doc: String,
    /// Extras the function declared (`masks`, `labels`, …).
    #[serde(default)]
    pub wants: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]   // ← Serialize MUST be here
pub struct PingReply {
    pub ok: bool,
    pub protocol_version: u32,
    /// Keypoint function names: all a protocol-1 peer reports.
    pub registered: Vec<String>,
    #[serde(default)]
    pub functions: Vec<FunctionInfo>,
}

impl PingReply {
    pub fn with_legacy_functions(mut self) -> Self {
        if self.functions.is_empty() {
            self.functions = self
                .registered
                .iter()
                .map(|name| FunctionInfo {
                    name: name.clone(),
                    kind: "keypoints".into(),
                    doc: String::new(),
                    wants: Vec::new(),
                })
                .collect();
        }
        self
    }
}

#[derive(Debug, Deserialize)]
pub struct FindKeypointsReply {
    pub pairs: Vec<[[f64; 2]; 2]>,
}

#[derive(Debug, Deserialize)]
pub struct WireMask {
    /// `None` targets the label active in the editor.
    pub label: Option<String>,
    #[serde(with = "serde_bytes")]
    pub buf: Vec<u8>,
    pub shape: Vec<usize>,
    /// The values only mean on/off, not instance ids.
    #[serde(default)]
    pub binary: bool,
}

#[derive(Debug, Deserialize)]
pub struct MasksReply {
    pub masks: Vec<WireMask>,
    /// Returned label names the project does not have.
    #[serde(default)]
    pub unknown: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct SeqRunReply {
    #[serde(default)]
    pub unknown: Vec<String>,
}
