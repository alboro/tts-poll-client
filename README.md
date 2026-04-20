# TTS Poll Client

Small local HTML client for polling-style TTS job APIs.

Start it:

```cmd
serve.cmd
```

On macOS / Linux you can run with Python 3.10+:

```sh
python3 server.py --host 127.0.0.1 --port 8099
```

Or make the included helper executable and run it:

```sh
chmod +x run.sh
./run.sh
```

Open:

```text
http://127.0.0.1:8099
```

The included proxy keeps browser CORS out of the way and only allows loopback
targets by default. Use `python server.py --allow-remote` only when you
explicitly need to test a non-local server.
