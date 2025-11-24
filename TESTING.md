# Teratron Network Testing Guide

## Why WebRTC Localhost Testing Is Challenging

WebRTC P2P connections often **fail when testing on the same machine** with the same browser because:
- NAT traversal doesn't work properly on localhost
- ICE candidates may not resolve correctly
- Browsers may block same-origin P2P connections

## Recommended Testing Approaches

### Option 1: Different Browsers (EASIEST)
Test on the same computer using different browsers:

**Host (Browser 1 - e.g., Chrome):**
```
http://localhost:5174/
→ Network Game → Create Room
→ Copy the room link
```

**Guest (Browser 2 - e.g., Firefox):**
```
Paste the room link in address bar
→ Should auto-join the room
```

### Option 2: Network IP (BEST FOR MULTI-DEVICE)
Test using your local network IP on different devices:

**Find Your IP:**
```bash
# macOS/Linux
ifconfig | grep "inet "

# Windows
ipconfig
```

**Host (Computer 1):**
```
http://192.168.x.x:5174/
→ Network Game → Create Room
→ Share the full URL with network IP
```

**Guest (Computer 2 / Phone / Tablet):**
```
http://192.168.x.x:5174/?room=ROOM_ID
→ Should auto-join
```

### Option 3: Incognito + Regular Window
Less reliable but worth trying:

**Host:** Regular window in Chrome
**Guest:** Incognito window in Firefox

## Current Test Status

✅ **Phase 2 Complete:**
- PeerJS integration
- Room creation and joining
- Lobby system with player list
- Room link sharing with auto-join
- ICE candidate exchange

⏳ **Testing Needed:**
- Successful P2P connection between browsers
- Message exchange verification
- Full lobby synchronization

❌ **Phase 3 (Not Yet Implemented):**
- Game state synchronization
- Input broadcasting
- Actual networked gameplay

## Troubleshooting

### Connection Timeout (30 seconds)
**Symptoms:** "Connection timeout - peer may not exist or network issues"

**Causes:**
- Same browser testing on localhost
- Firewall blocking WebRTC
- NAT/router configuration

**Solutions:**
1. Try different browsers (Chrome ↔ Firefox)
2. Try network IP instead of localhost
3. Check firewall settings
4. Ensure both browsers have WebRTC enabled

### Room Creation Fails
**Symptoms:** "Failed to create room"

**Solutions:**
1. Check console for PeerJS errors
2. Verify internet connection (PeerJS cloud server needs access)
3. Check browser console for 404 errors

### Copy Link Doesn't Work
**Symptoms:** Copy button shows "Failed"

**Solutions:**
1. Grant clipboard permissions in browser
2. Manually copy the URL from address bar
3. Manually copy room code and paste in join dialog

## Console Debugging

### Successful Host:
```
✅ Peer initialized with ID: [room-id]
🎮 Room created with ID: [room-id]
📞 Incoming connection from: [guest-peer-id]
✅ Connection opened with: [guest-peer-id]
```

### Successful Guest:
```
✅ Peer initialized with ID: [my-peer-id]
🔌 Attempting to connect to: [room-id]
🔌 ICE state: checking
🔌 ICE state: connected
✅ Connected to: [room-id]
✅ Welcomed as Player 1
```

### Failed Connection (Timeout):
```
🔌 ICE state: checking
🔌 ICE state: failed
❌ Connection timeout after 30 seconds
```

## Next Steps After Successful Connection

Once you see both host and guest showing "Connection opened" / "Connected":

1. Verify guest appears in host's lobby
2. Verify host's player list shows in guest's lobby
3. Test disconnect/reconnect
4. Ready for Phase 3 implementation (game state sync)
