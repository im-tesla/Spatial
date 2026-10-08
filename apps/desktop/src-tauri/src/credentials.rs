use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct SavedConnection {
    pub address: String,
    pub token: String,
}

const TARGET: &str = "Spatial/ServerConnection";

pub fn load() -> Result<Option<SavedConnection>, String> {
    platform::load(TARGET)
}

pub fn save(connection: &SavedConnection) -> Result<(), String> {
    platform::save(TARGET, connection)
}

#[cfg(windows)]
mod platform {
    use super::SavedConnection;
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW,
        CredFree, CredReadW, CredWriteW,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub fn load(target: &str) -> Result<Option<SavedConnection>, String> {
        let target = wide(target);
        let mut credential = std::ptr::null_mut();
        // WinCred owns this allocation until CredFree; the blob is opaque app data.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            let code = unsafe { GetLastError() };
            return if code == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(format!(
                    "Cannot read the saved connection from Windows Credential Manager ({code})."
                ))
            };
        }
        struct Allocation(*mut CREDENTIALW);
        impl Drop for Allocation {
            fn drop(&mut self) {
                unsafe { CredFree(self.0.cast()) };
            }
        }
        let allocation = Allocation(credential);
        let credential = unsafe { &*allocation.0 };
        if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
            return Err(
                "The saved Spatial connection is empty. Enter your access token again.".into(),
            );
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        serde_json::from_slice(bytes).map(Some).map_err(|_| {
            "The saved Spatial connection cannot be read. Enter your access token again.".into()
        })
    }

    pub fn save(target: &str, connection: &SavedConnection) -> Result<(), String> {
        save_to(target, connection)
    }

    fn save_to(target: &str, connection: &SavedConnection) -> Result<(), String> {
        let mut target = wide(target);
        let mut username = wide("Spatial");
        let mut blob = serde_json::to_vec(connection)
            .map_err(|_| "Cannot encode the Spatial connection.".to_string())?;
        if blob.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err(
                "The server address and token are too long for Windows Credential Manager.".into(),
            );
        }
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            UserName: username.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(format!(
                "Cannot save the connection in Windows Credential Manager ({}).",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::Security::Credentials::CredDeleteW;
        // WinCred is process-external state; keep credential writes/deletes sequential.
        static CREDENTIAL_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

        struct TestCredential(String);
        impl TestCredential {
            fn new() -> Self {
                Self(format!("Spatial/test-{}", uuid::Uuid::new_v4()))
            }
        }
        impl Drop for TestCredential {
            fn drop(&mut self) {
                unsafe { CredDeleteW(wide(&self.0).as_ptr(), CRED_TYPE_GENERIC, 0) };
            }
        }

        #[test]
        fn credential_round_trip_overwrite_and_missing() {
            let _guard = CREDENTIAL_TESTS.lock().unwrap();
            let target = TestCredential::new();
            assert!(load(&target.0).unwrap().is_none());
            let original = SavedConnection {
                address: "http://spatial.local:8787".into(),
                token: "test-only-密钥-ą".into(),
            };
            save_to(&target.0, &original).unwrap();
            let loaded = load(&target.0).unwrap().unwrap();
            assert_eq!(loaded.address, original.address);
            assert_eq!(loaded.token, original.token);
            let replacement = SavedConnection {
                address: "http://192.168.1.20:8787".into(),
                token: "replacement-test-only".into(),
            };
            save_to(&target.0, &replacement).unwrap();
            let loaded = load(&target.0).unwrap().unwrap();
            assert_eq!(loaded.address, replacement.address);
            assert_eq!(loaded.token, replacement.token);
        }

        #[test]
        fn oversized_credential_preserves_previous_value() {
            let _guard = CREDENTIAL_TESTS.lock().unwrap();
            let target = TestCredential::new();
            let original = SavedConnection {
                address: "http://localhost:8787".into(),
                token: "test-only".into(),
            };
            save_to(&target.0, &original).unwrap();
            let oversized = SavedConnection {
                address: original.address.clone(),
                token: "x".repeat(CRED_MAX_CREDENTIAL_BLOB_SIZE as usize),
            };
            assert!(save_to(&target.0, &oversized).is_err());
            assert_eq!(load(&target.0).unwrap().unwrap().token, original.token);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SavedConnection;
    pub fn load(_: &str) -> Result<Option<SavedConnection>, String> {
        Ok(None)
    }
    pub fn save(_: &str, _: &SavedConnection) -> Result<(), String> {
        Err("Saved connections require the Windows desktop app.".into())
    }
}
