//! Stand-in for `commands::ml` on Android, where the training stack (ONNX
//! Runtime, burn) is not built. It keeps the project commands, which reset the
//! model state when a project changes, identical on every platform.

pub mod predict {
    use parking_lot::Mutex;

    pub struct Model {
        pub label_order: Vec<i64>,
    }

    #[derive(Default)]
    pub struct MlState {
        pub model: Mutex<Option<Model>>,
        pub features: Mutex<Option<()>>,
    }
}

pub mod commands {
    use tauri::State;

    use super::predict::MlState;
    use crate::storage::DbState;

    /// No model can be stored or restored without the training stack.
    pub fn ml_load_saved_model(_db: State<DbState>, _state: State<MlState>) {}
}
