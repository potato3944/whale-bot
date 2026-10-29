# Third-party notices

## qq-bridge role card, QQ tool protocol and web tools

`app/role.qqbridge.md` is adapted from `roles/小鲸鱼.md` in
https://github.com/Derpyu520/qq-bridge at commit `a49877f4e58d04e47532d44b803360d0f001160d`.
`app/role.private.md` retains the whale identity from that card. Its current
private-chat adaptation also draws on the dafeiyu persona credited below.

`app/src/qq-read-receipts.js` adapts `readThroughSeqV2` and
`requestedReadThroughSeqV2` from `src/bridge.js` at the same commit.
`app/src/qq-tools.js` reuses tool names, parameter semantics, selected descriptions
and JSON message normalization from `src/mcp-snowluma-safe.js`.
`app/src/transport-onebot.js` adapts `escapeCqText` from `src/bridge.js`
to neutralize literal CQ control codes in plain text.
`app/src/qq-tool-guide.js` adapts the QQ tool protocol from the `qq-chat-v2` preset.
`app/src/social-memory-format.js` adapts `formatMemoryV2` from `src/bridge.js`;
the social-memory categories and 24-hour topic / 2-hour pending-thought defaults
also follow that implementation. Session-bound JSON storage, fact/event entries,
source validation, ID-based updates and bounded revisions are local adaptations.
HTTP/MCP wrappers are replaced by session-bound in-process Pi tools. Cursorless
acknowledgement compatibility and long-poll waiting are deliberately omitted.

`app/src/safe-fetch.js` and `app/src/web-search.js` adapt the upstream modules
at the same commit. DSH credential discovery is removed; cancellation support
and session-bound tool limits are added. `app/src/web-tools.js` adapts the
search/reading guidance from the qq-chat-v2 preset without slang storage.

The personality and examples are retained. Search, webpage reading and
agent-controlled waiting instructions are adapted to the capabilities
actually available in whale-bot. A short runtime/remember note is added.

MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dafeiyu private-chat persona

`app/role.private.md` adapts the compact structure, food/slacking-off traits,
concrete speaking rules and example-based style of `persona/大肥鱼.md` from
https://github.com/zexuanw958-svg/dafeiyu-config-pack at commit
`8c01b0361b8a4baff5be3d2bc67ed55108953086`.
Examples are rewritten for whale-bot; private-chat boundaries and existing tool
limits are retained. Signature changes, reminders, meme sending and other
upstream plugin abilities are not imported.

MIT License

Copyright (c) 2026 zexuanw958-svg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## QFace QQ face names

`app/src/qq-faces.json` contains the ID/name fields from
https://github.com/koishijs/QFace/blob/e476a706a7e508849c6031c3654051a02639964f/public/assets/qq_emoji/_index.json.

MIT License

Copyright (c) 2020-present Shigma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
