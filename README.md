# TTS Poll Client

Small local HTML client for polling-style TTS job APIs.

Start it:

```cmd
serve.cmd
```

Open:

```text
http://127.0.0.1:8099
```

The included proxy keeps browser CORS out of the way and only allows loopback
targets by default. Use `python server.py --allow-remote` only when you
explicitly need to test a non-local server.
