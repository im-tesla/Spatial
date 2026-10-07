use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub album_id: String,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub date: String,
    pub disc_number: u32,
    pub track_number: u32,
    pub duration: f64,
    pub codec: String,
    pub profile: String,
    pub atmos: bool,
    pub sample_rate: u32,
    pub channels: u32,
    pub bitrate: u64,
    pub artwork_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Album {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub date: String,
    pub track_count: usize,
    pub duration: f64,
    pub atmos: bool,
    pub artwork_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Library {
    pub revision: u64,
    pub albums: Vec<Album>,
    pub tracks: Vec<Track>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaybackGrant {
    pub path: String,
    pub expires: u64,
    pub track: Track,
}
