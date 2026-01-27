pub const SCHEMA: &str = r#"
-- Project metadata (single row)
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    config JSON NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Labels
CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    is_instance BOOLEAN DEFAULT FALSE,
    sort_order INTEGER DEFAULT 0
);

-- Sequences (every image belongs to a sequence, even if alone)
CREATE TABLE IF NOT EXISTS sequences (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
);

-- Frames (images within sequences)
CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    frame_index INTEGER NOT NULL,
    relative_path TEXT,
    content_hash TEXT,
    embedded_data BLOB,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    reviewed BOOLEAN DEFAULT FALSE,
    UNIQUE(sequence_id, frame_index)
);

-- Annotations (per frame, per label)
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    encoding TEXT NOT NULL DEFAULT 'rle',
    mask_data BLOB NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_id)
);
CREATE TABLE IF NOT EXISTS classifications (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    task_name TEXT NOT NULL,
    selected_classes JSON NOT NULL,
    is_multilabel BOOLEAN DEFAULT FALSE,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, task_name)
);
CREATE TABLE IF NOT EXISTS text_descriptions (
    id INTEGER PRIMARY KEY,
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    label_name TEXT NOT NULL,
    content TEXT NOT NULL,
    modified_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(frame_id, label_name)
);

CREATE INDEX IF NOT EXISTS idx_frames_sequence ON frames(sequence_id);
CREATE INDEX IF NOT EXISTS idx_annotations_frame ON annotations(frame_id);
CREATE INDEX IF NOT EXISTS idx_classifications_frame ON classifications(frame_id);
CREATE INDEX IF NOT EXISTS idx_text_descriptions_frame ON text_descriptions(frame_id);
"#;