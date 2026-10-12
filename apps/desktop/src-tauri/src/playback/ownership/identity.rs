use serde::{Deserialize, Serialize};
use std::io;
use tokio::process::Child;

#[derive(Serialize, Deserialize)]
pub(super) struct Identity {
    pub(super) pid: u32,
    pub(super) started: u64,
    #[cfg(target_os = "linux")]
    #[serde(default)]
    boot_id: String,
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{Foundation::*, System::Threading::*};

    fn started(handle: HANDLE) -> io::Result<u64> {
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        // All output pointers are valid FILETIME values, and the handle is owned.
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
    }

    impl Identity {
        pub(crate) fn capture(child: &Child) -> io::Result<Self> {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Player already exited"))?;
            let handle = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("Player handle unavailable"))?;
            Ok(Self {
                pid,
                started: started(handle)?,
            })
        }

        pub(crate) fn terminate_if_same(&self) -> io::Result<()> {
            // Keep one process handle for validation and termination; a recycled
            // PID cannot redirect termination to a different process afterward.
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    0,
                    self.pid,
                )
            };
            if raw.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                    Ok(())
                } else {
                    Err(error)
                };
            }
            let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
            if started(handle.as_raw_handle())? != self.started {
                return Ok(());
            }
            if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
                return Ok(());
            }
            if unsafe { TerminateProcess(handle.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            match unsafe { WaitForSingleObject(handle.as_raw_handle(), 3000) } {
                WAIT_OBJECT_0 => Ok(()),
                WAIT_TIMEOUT => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Previous player did not exit",
                )),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn boot_id() -> io::Result<String> {
        Ok(std::fs::read_to_string("/proc/sys/kernel/random/boot_id")?
            .trim()
            .to_owned())
    }

    fn started(pid: u32) -> io::Result<u64> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
        // comm can contain spaces and parentheses. Fields following the final
        // closing parenthesis start at field 3; starttime is field 22.
        stat.rsplit_once(") ")
            .and_then(|(_, fields)| fields.split_whitespace().nth(19))
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| io::Error::other("Invalid player identity"))
    }

    impl Identity {
        pub(crate) fn capture(child: &Child) -> io::Result<Self> {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("Player already exited"))?;
            Ok(Self {
                pid,
                started: started(pid)?,
                boot_id: boot_id()?,
            })
        }

        pub(crate) fn terminate_if_same(&self) -> io::Result<()> {
            // Linux start times are relative to boot. Old records must not match
            // a new process after a reboot resets the PID and uptime counters.
            if boot_id()? != self.boot_id {
                return Ok(());
            }
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, self.pid, 0) };
            if fd < 0 {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(())
                } else {
                    Err(error)
                };
            }
            let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
            match started(self.pid) {
                Ok(value) if value == self.started => {}
                Ok(_) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            }
            // Signal the pinned process, never a later occupant of its PID.
            if unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            } < 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::ESRCH) {
                    return Err(error);
                }
            }
            let mut poll = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            match unsafe { libc::poll(&mut poll, 1, 3000) } {
                value if value > 0 => Ok(()),
                0 => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Previous player did not exit",
                )),
                _ => Err(io::Error::last_os_error()),
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
impl Identity {
    pub(crate) fn capture(_: &Child) -> io::Result<Self> {
        Err(io::Error::other("Unsupported playback platform"))
    }
    pub(crate) fn terminate_if_same(&self) -> io::Result<()> {
        Err(io::Error::other("Unsupported playback platform"))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_previous_boot_cannot_authorize_termination() {
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut saved = Identity::capture(&child).unwrap();
        saved.boot_id = "a previous boot".into();
        saved.terminate_if_same().unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.kill().await.unwrap();
    }
}
