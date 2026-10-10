//! Stand-in for `commands::ml` on Android, where the training stack is not
//! built, so the project commands are the same on every platform.

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

    pub fn ml_load_saved_model(_db: State<DbState>, _state: State<MlState>) {}
}
