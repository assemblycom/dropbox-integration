export const MAX_FILES_LIMIT = 150

// Items per batchTriggerAndWait call, kept within Trigger.dev's batch limit.
export const BATCH_CHUNK_SIZE = 150

export const DBX_URL_PATH = {
  fileUpload: '/files/upload',
  fileDownload: '/files/download',
}

// Files above this use an upload session, not /files/upload.
export const DROPBOX_SINGLE_UPLOAD_MAX_BYTES = 150 * 1024 * 1024

// Bytes per upload-session append (a multiple of 4 MiB, per Dropbox).
export const DROPBOX_UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024
