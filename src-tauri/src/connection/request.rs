use serde::{Deserialize, Serialize};


#[derive(Serialize)]
pub struct ImagePayload {
    #[serde(with = "serde_bytes")]
    pub buf: Vec<u8>,
    pub shape: Vec<usize>,
    pub dtype: String,         // "uint8" | "uint16" | "float32"
}

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
}
#[derive(Debug, Serialize, Deserialize)]   // ← Serialize MUST be here
pub struct PingReply {
    pub ok: bool,
    pub protocol_version: u32,
    pub registered: Vec<String>,
}
#[derive(Debug, Deserialize)]
pub struct FindKeypointsReply {
    pub ok: bool,
    pub pairs: Vec<[[f64; 2]; 2]>,
    #[serde(default)]
    pub error: Option<String>,
}