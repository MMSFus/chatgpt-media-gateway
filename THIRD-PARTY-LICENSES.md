# Third-Party Notices

## Sentinel challenge helpers

The Turnstile `dx` interpreter in `src/turnstile.js` and the legacy Sentinel
signal/PoW implementation in `src/upstream.js` are adapted from
[`basketikun/chatgpt2api`](https://github.com/basketikun/chatgpt2api),
`utils/turnstile.py` and `utils/pow.py`.

Copyright (c) 2026 kunkun

MIT License

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

## sharp and libvips

The image resizing module uses `sharp` version 0.35.5, distributed under the
Apache-2.0 license. sharp uses the libvips image processing library, which is
distributed under the LGPL-3.0 license. Platform-specific sharp binaries are
optional npm dependencies recorded in `package-lock.json`.

The full license texts and notices are available from the respective projects:

- sharp: https://github.com/lovell/sharp/blob/main/LICENSE
- libvips: https://github.com/libvips/libvips/blob/master/COPYING
