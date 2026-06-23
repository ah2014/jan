#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub is_directory: bool,
    pub size: u64,
}

/// One entry returned by the remote-attach file walker (`~` picker).
///
/// `path` is the absolute, canonicalized filesystem path that the frontend
/// hands back to `readAttachFileBase64` when the user picks the entry. `name`
/// is just the basename for display. `is_dir` is true for folders so the
/// picker can render a folder icon (folders are listed but not selectable).
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Bytes for a remotely-attached file, returned by `readAttachFileBase64`.
/// `base64` carries the raw file content (so the browser can rebuild a
/// `Blob`/`File` identical to an uploaded one); `size` is the original byte
/// length, useful for size validation on the frontend.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachFileBytes {
    pub base64: String,
    pub size: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOpenOptions {
    pub multiple: Option<bool>,
    pub directory: Option<bool>,
    pub default_path: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_stat_serializes_with_camel_case() {
        let stat = FileStat {
            is_directory: true,
            size: 4096,
        };
        let json = serde_json::to_string(&stat).unwrap();
        assert!(json.contains("\"isDirectory\":true"));
        assert!(json.contains("\"size\":4096"));
        assert!(!json.contains("is_directory"));
    }

    #[test]
    fn dialog_filter_round_trips() {
        let filter = DialogFilter {
            name: "Images".into(),
            extensions: vec!["png".into(), "jpg".into()],
        };
        let json = serde_json::to_string(&filter).unwrap();
        let parsed: DialogFilter = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Images");
        assert_eq!(parsed.extensions, vec!["png", "jpg"]);
    }

    #[test]
    fn dialog_open_options_uses_camel_case_for_default_path() {
        let opts = DialogOpenOptions {
            multiple: Some(true),
            directory: Some(false),
            default_path: Some("/tmp".into()),
            filters: None,
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"defaultPath\":\"/tmp\""));
        assert!(json.contains("\"multiple\":true"));
        assert!(json.contains("\"directory\":false"));
    }

    #[test]
    fn dialog_open_options_deserializes_with_missing_fields() {
        let json = r#"{}"#;
        let parsed: DialogOpenOptions = serde_json::from_str(json).unwrap();
        assert!(parsed.multiple.is_none());
        assert!(parsed.directory.is_none());
        assert!(parsed.default_path.is_none());
        assert!(parsed.filters.is_none());
    }

    #[test]
    fn dialog_open_options_deserializes_camel_case() {
        let json = r#"{"defaultPath":"/x","filters":[{"name":"T","extensions":["txt"]}]}"#;
        let parsed: DialogOpenOptions = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.default_path.as_deref(), Some("/x"));
        let filters = parsed.filters.unwrap();
        assert_eq!(filters.len(), 1);
        assert_eq!(filters[0].name, "T");
    }
}
