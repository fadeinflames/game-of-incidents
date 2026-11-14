"""Plumbing shared by the pipeline components: logging, graceful stop, Redis and PostgreSQL connections,
and a small HTTP endpoint for probes and metrics."""
import logging
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pg8000.native
import redis

# every release lives in its own directory: /opt/pipeline/releases/<release>/
RELEASE = os.path.basename(os.path.dirname(os.path.abspath(__file__)))

stopping = threading.Event()


def setup(component):
    level = os.environ.get("LOG_LEVEL", "info").upper()
    logging.basicConfig(
        stream=sys.stdout,
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-5s %(message)s",
        datefmt="%H:%M:%S",
    )
    # PID 1 ignores SIGTERM unless it has a handler; the main loop finishes what it is doing and leaves
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    return logging.getLogger(component)


def redis_client():
    return redis.Redis(
        host=os.environ.get("REDIS_HOST", "redis"),
        port=6379,
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=10,
    )


def pg_connect():
    return pg8000.native.Connection(
        user=os.environ.get("PGUSER", "hooks"),
        password=os.environ.get("PGPASSWORD", "hooks"),
        host=os.environ.get("PGHOST", "postgres"),
        port=5432,
        database=os.environ.get("PGDATABASE", "hooks"),
        timeout=5,
    )


def ensure_group(client, stream, group):
    """The consumer group is created on first use, at the beginning of the stream: nothing written earlier is lost."""
    try:
        client.xgroup_create(stream, group, id="0", mkstream=True)
        return True
    except redis.ResponseError as e:
        if "BUSYGROUP" in str(e):
            return False
        raise


def metrics_text(component, record_format, counters, help_texts):
    lines = [
        "# HELP pipeline_build_info Release of the component and the handoff format of delivery records it speaks.",
        "# TYPE pipeline_build_info gauge",
        'pipeline_build_info{component="%s",release="%s",record_format="%s"} 1' % (component, RELEASE, record_format),
    ]
    for name, value in counters.items():
        if name in help_texts:
            lines.append("# HELP %s %s" % (name, help_texts[name]))
        lines.append("# TYPE %s %s" % (name, "counter" if name.endswith("_total") else "gauge"))
        lines.append("%s %s" % (name, value))
    return "\n".join(lines) + "\n"


def serve_http(port, routes):
    """routes: path -> callable returning (status, content type, body). Runs in a daemon thread."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            fn = routes.get(self.path.split("?", 1)[0])
            if fn is None:
                code, ctype, body = 404, "text/plain", "not found\n"
            else:
                try:
                    code, ctype, body = fn()
                except Exception as e:  # noqa: BLE001
                    code, ctype, body = 500, "text/plain", "%r\n" % (e,)
            data = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            pass

    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
