use thiserror::Error;

#[derive(Error, Debug)]
pub enum ComError {
    #[error("ZMQ error: {0}")]
    ZmqError(#[from] zmq::Error),
    #[error("Other error: {0}")]
    Other(String),
    /// The Python peer answered `ok: false`; the message is its own.
    #[error("{0}")]
    Peer(String),
    #[error("Python did not answer in time")]
    NoReply,
    /// The request could not be handed over within the send timeout.
    #[error("Python is not accepting requests")]
    NotListening,
}

