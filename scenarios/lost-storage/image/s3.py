"""Minimal AWS SigV4 client for an S3-compatible endpoint (MinIO): PUT/GET/HEAD object, PUT bucket. No third-party deps."""
import datetime
import hashlib
import hmac
import urllib.error
import urllib.request


class S3Error(Exception):
    def __init__(self, status, code, body):
        super().__init__(f"{status} {code}")
        self.status, self.code, self.body = status, code, body


def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def request(endpoint, access_key, secret_key, method, bucket, key="", body=b"", region="us-east-1"):
    host = endpoint.split("://", 1)[1]
    path = f"/{bucket}" + (f"/{key}" if key else "")
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(body).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canonical = "\n".join([method, path, "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, payload_hash])
    scope = f"{date}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    k = _sign(_sign(_sign(_sign(("AWS4" + secret_key).encode(), date), region), "s3"), "aws4_request")
    signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    auth = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}"
    req = urllib.request.Request(endpoint + path, data=body if method in ("PUT", "POST") else None, method=method)
    for k2, v in headers.items():
        if k2 != "host":
            req.add_header(k2, v)
    req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        code = "Unknown"
        if "<Code>" in text:
            code = text.split("<Code>", 1)[1].split("</Code>", 1)[0]
        raise S3Error(e.code, code, text) from None
