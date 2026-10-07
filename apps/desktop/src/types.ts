export interface Track {
  id: string; album_id: string; title: string; artist: string; album_artist: string;
  album: string; date: string; disc_number: number; track_number: number; duration: number;
  codec: string; profile: string; atmos: boolean; sample_rate: number; channels: number;
  bitrate: number; artwork_id: string | null;
}
export interface Album {
  id: string; title: string; artist: string; date: string; track_count: number;
  duration: number; atmos: boolean; artwork_id: string | null;
}
export interface Library { revision: number; albums: Album[]; tracks: Track[] }
export interface AudioDevice { name: string; description: string }
export interface PlaybackStatus {
  track_id: string | null; active: boolean; paused: boolean; ended: boolean;
  position: number; duration: number; passthrough: boolean; output_format: string;
  output_driver: string; error: string | null;
}
export interface RememberedConnection {
  address: string;
  library: Library | null;
  error: string | null;
}

