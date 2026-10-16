# Controller controls

Connect a controller supported by your operating system and press a button while Spatial is the foreground window. Controller input is on by default and works in the library, album tracks, queue, Settings, lyrics and fullscreen player.

| Input | Action |
| --- | --- |
| D-pad / left stick | Navigate controls |
| A / Cross | Select |
| B / Circle | Close the open dropdown or dialog, then fullscreen, then the album view |
| Menu / Options | Play or pause the active track |
| LB / L1 | Back 10 seconds |
| RB / R1 | Forward 10 seconds |
| Y / Triangle | Enter or exit fullscreen |
| Right stick up/down | Scroll the focused panel or track list |

Focus follows the album palette and scrolls controls into view, including rows outside the current viewport. A first Select press establishes focus if nothing is selected. Left/right adjust a focused seek slider; up/down leave the slider. Text entry still uses the keyboard. Seeking, navigation and scrolling repeat while held; Select, Back, Play/Pause and Fullscreen fire once per press.

Open **Settings → Controller** to change the six button bindings or disable controller input. The dropdowns use Spatial's own design and show Xbox and PlayStation names. Choosing a button already in use swaps the assignments. **Reset mapping** changes the draft to defaults; **Save settings** persists and applies the draft. Closing Settings without saving leaves the current mapping active. These preferences stay on this client.

Spatial checks the native app window before dispatching input. Minimized, hidden and inactive windows ignore the controller. After switching back, reconnecting or saving a mapping, release held controls before pressing again. Mouse and keyboard interaction clears the controller focus style.

Only controllers reported with the browser Gamepad API's **standard** mapping are interpreted. Raw/unmapped devices are not assigned guessed Xbox indices. Detection depends on WebView2 on Windows and the installed WebKitGTK/controller backend on Linux. If input is unavailable, Settings reports it. Other software that translates controller input into mouse or keyboard events may produce duplicate actions; use one input path.

Playback still uses Spatial's existing native mpv process and HDMI bitstream path. There is no video overlay, separate player window or playback-speed adjustment, and no server update is needed. Spatial does not have Watch Together rooms or subtitle controls.

For development, `/tests/app-preview.html?connection=saved&showcase&controller` installs a test-only virtual standard controller. The fixture first records the real API/security-context availability and only then replaces `getGamepads()`. Its test panel supplies button presses, disconnection and inactive-window cases without audio or real controller hardware. The production bundle excludes the fixture. Add `native-controller` only when running this page inside a debug Tauri window to retain real native foreground/fullscreen checks.
