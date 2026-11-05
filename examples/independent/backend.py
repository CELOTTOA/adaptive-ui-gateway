"""Standalone AUG 0.2 inventory example; Python standard library only.

Implements the two fixed operations in operations.json, not a general JSON Schema engine.
All credentials and stock are public, synthetic fixtures. No durable effects or state.
"""
import argparse
import copy
import hmac
import json
import math
import re
import secrets
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

VERSION = "aug/0.2"
LIMIT = 32768
OPERATIONS = json.loads(Path(__file__).with_name("operations.json").read_text("utf-8"))
ACTORS = {
    "independent-demo-token": ("alice", "tenant-a", ("stock:use",)),
    "independent-other-token": ("bob", "tenant-b", ("stock:use",)),
    "independent-denied-token": ("alice", "tenant-a", ()),
}


class Refusal(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


def require(condition, status=400, code="INVALID_INVOCATION"):
    if not condition:
        raise Refusal(status, code)


def exact(value, required, optional=()):
    require(type(value) is dict and set(required) <= value.keys()
            and value.keys() <= set(required) | set(optional))


def string(value, maximum):
    return type(value) is str and 1 <= len(value) <= maximum


def finite_json(value, depth=0):
    require(depth <= 32)
    if type(value) is dict:
        for child in value.values():
            finite_json(child, depth + 1)
    elif type(value) is list:
        for child in value:
            finite_json(child, depth + 1)
    elif type(value) in (int, float):
        require(math.isfinite(value) and abs(value) <= 9007199254740991)
    else:
        require(value is None or type(value) in (str, bool))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 400, "INVALID_JSON")
        result[key] = value
    return result


def validate_input(operation, value):
    # This backend accepts no externally registered schemas. Enforce every keyword
    # in its two published schemas, without coercion, defaults or extra properties.
    schema = operation["inputSchema"]
    require(type(value) is dict, 400, "INVALID_INPUT")
    require(value.keys() <= schema["properties"].keys()
            and set(schema.get("required", [])) <= value.keys(), 400, "INVALID_INPUT")
    for key, item in value.items():
        field = schema["properties"][key]
        valid = False
        if field["type"] == "string":
            valid = type(item) is str and field.get("minLength", 0) <= len(item) <= field["maxLength"]
        elif field["type"] == "integer":
            # JSON Schema integer describes a mathematical integer, including 2.0.
            valid = type(item) in (int, float) and math.isfinite(item) and int(item) == item
            valid = valid and field["minimum"] <= item <= field["maximum"]
        require(valid, 400, "INVALID_INPUT")


def select(operation, runtime):
    keys = ("protocolVersions", "profiles", "mediaTypes", "deliveryKinds")
    exact(runtime, keys)
    limits = {"protocolVersions": (16, 64), "profiles": (128, 300), "mediaTypes": (64, 200), "deliveryKinds": (2, 200)}
    for key in keys:
        values = runtime[key]
        maximum, length = limits[key]
        require(type(values) is list and 1 <= len(values) <= maximum
                and all(string(v, length) for v in values)
                and len(set(values)) == len(values))
    require(all(re.fullmatch(r"[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*", v)
                for v in runtime["mediaTypes"]))
    require(all(v in ("inline", "reference") for v in runtime["deliveryKinds"]))
    require(VERSION in runtime["protocolVersions"], 406, "UNSUPPORTED_PROTOCOL_VERSION")
    for offer in operation["output"]:
        if ("view" in offer["audiences"] and offer["profile"] in runtime["profiles"]
                and offer["mediaType"] in runtime["mediaTypes"] and offer["deliveryKind"] in runtime["deliveryKinds"]):
            return offer
    raise Refusal(406, "NO_COMPATIBLE_REPRESENTATION")


class Inventory:
    def __init__(self):
        require(len(OPERATIONS) == 2 and {o["id"] for o in OPERATIONS}
                == {"inventory.stock.list", "inventory.stock.reserve"})
        for operation in OPERATIONS:
            schema = operation["inputSchema"]
            require(schema.keys() <= {"type", "additionalProperties", "required", "properties"}
                    and schema["type"] == "object" and schema["additionalProperties"] is False)
            for field in schema["properties"].values():
                if field["type"] == "string":
                    require(field.keys() <= {"type", "minLength", "maxLength"} and "maxLength" in field)
                else:
                    require(field["type"] == "integer" and field.keys() == {"type", "minimum", "maximum"})
        self.records, self.requests = {}, {}
        self.stock = {
            "tenant-a": [{"sku": "BOLT-A", "available": 20}, {"sku": "WASHER-A", "available": 30}],
            "tenant-b": [{"sku": "BOLT-B", "available": 9}],
        }

    def operation(self, actor, operation_id):
        found = next((o for o in OPERATIONS if o["id"] == operation_id), None)
        require(found is not None and "stock:use" in actor[2], 404, "OPERATION_NOT_FOUND")
        return found

    def prune(self):
        now = time.time() * 1000
        for key, record in list(self.records.items()):
            invocation = record["invocation"]
            if invocation["state"] == "awaiting_confirmation" and now >= invocation["confirmation"]["expiresAt"]:
                self.move(record, "expired")
            if record.get("retireAt", float("inf")) <= now:
                del self.requests[record["requestKey"]]
                del self.records[key]

    def move(self, record, state, **payload):
        old = record["invocation"]
        record["invocation"] = {k: old[k] for k in
                                ("protocolVersion", "id", "operationId", "operationVersion", "revision")}
        record["invocation"].update(state=state, revision=old["revision"] + 1, **payload)
        if state not in ("running", "awaiting_confirmation"):
            record["retireAt"] = time.time() * 1000 + 900000

    def invoke(self, actor, request):
        exact(request, ("protocolVersion", "requestId", "operationId", "operationVersion", "input", "runtime"))
        require(string(request["requestId"], 128) and string(request["operationId"], 200)
                and string(request["operationVersion"], 64) and string(request["protocolVersion"], 64)
                and type(request["input"]) is dict)
        require(request["protocolVersion"] == VERSION, 406, "UNSUPPORTED_PROTOCOL_VERSION")
        operation = self.operation(actor, request["operationId"])
        require(request["operationVersion"] == operation["version"], 409, "OPERATION_VERSION_MISMATCH")
        validate_input(operation, request["input"])
        offer = select(operation, request["runtime"])
        self.prune()
        request_key = (actor[0], actor[1], request["requestId"])
        def normalized(value):
            if type(value) is dict:
                return {key: normalized(item) for key, item in value.items()}
            if type(value) is list:
                return [normalized(item) for item in value]
            return int(value) if type(value) is float and value.is_integer() else value
        fingerprint = json.dumps(normalized(request), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        previous = self.requests.get(request_key)
        if previous:
            record = self.records[previous]
            require(record["fingerprint"] == fingerprint, 409, "IDEMPOTENCY_CONFLICT")
            require(set(record["scopes"]) <= set(actor[2]), 404, "INVOCATION_NOT_FOUND")
            return record["invocation"]
        require(len(self.records) < 512, 503, "TOO_MANY_INVOCATIONS")
        invocation_id = secrets.token_hex(16)
        pending = operation["confirmation"] == "explicit"
        invocation = {"protocolVersion": VERSION, "id": invocation_id,
                      "operationId": operation["id"], "operationVersion": operation["version"],
                      "revision": 1, "state": "awaiting_confirmation" if pending else "running"}
        if pending:
            invocation["confirmation"] = {"token": secrets.token_hex(32),
                                          "expiresAt": time.time() * 1000 + 300000,
                                          "input": copy.deepcopy(request["input"])}
        record = {"invocation": invocation, "request": copy.deepcopy(request), "offer": offer,
                  "owner": actor[:2], "scopes": actor[2], "fingerprint": fingerprint, "requestKey": request_key,
                  "confirmationToken": invocation.get("confirmation", {}).get("token")}
        self.records[invocation_id] = record
        self.requests[request_key] = invocation_id
        if not pending:
            self.execute(record, actor)
        return record["invocation"]

    def control(self, actor, request):
        require(type(request) is dict)
        action = request.get("action")
        require(action in ("status", "confirm"))
        exact(request, ("protocolVersion", "action", "invocationId") + (("token",) if action == "confirm" else ()))
        require(string(request["invocationId"], 128))
        require(string(request["protocolVersion"], 64))
        require(request["protocolVersion"] == VERSION, 406, "UNSUPPORTED_PROTOCOL_VERSION")
        if action == "confirm":
            require(string(request["token"], 128))
        self.prune()
        record = self.records.get(request["invocationId"])
        require(record is not None and record["owner"] == actor[:2]
                and set(record["scopes"]) <= set(actor[2]), 404, "INVOCATION_NOT_FOUND")
        self.operation(actor, record["request"]["operationId"])
        current = record["invocation"]
        if action == "confirm":
            expected = record["confirmationToken"]
            require(expected is not None and hmac.compare_digest(request["token"].encode("utf-8"), expected.encode("utf-8")),
                    403, "CONFIRMATION_DENIED")
            if current["state"] == "expired":
                raise Refusal(409, "CONFIRMATION_EXPIRED")
            if current["state"] == "awaiting_confirmation":
                self.move(record, "running")
                self.execute(record, actor)
        return record["invocation"]

    def execute(self, record, actor):
        request, offer = record["request"], record["offer"]
        try:
            self.operation(actor, request["operationId"])
            stock = self.stock[actor[1]]
            if request["operationId"] == "inventory.stock.list":
                query = request["input"].get("q", "").casefold()
                rows = [dict(row) for row in stock if query in row["sku"].casefold()]
                value = {"columns": [{"key": "sku"}, {"key": "available"}], "rows": rows}
                if offer["profile"] == "aug.text/0.1":
                    value = "\n".join(f'{row["sku"]}: {row["available"]}' for row in rows)
            else:
                item = next(row for row in stock if row["sku"] == request["input"]["sku"])
                quantity = int(request["input"]["quantity"])
                require(item["available"] >= quantity, 409, "INSUFFICIENT_STOCK")
                item["available"] -= quantity
                value = {"sku": item["sku"], "reserved": quantity, "available": item["available"]}
            output = {"protocolVersion": VERSION, "outputId": record["invocation"]["id"], "audience": "view",
                      "representation": {"id": offer["id"], "profile": offer["profile"], "mediaType": offer["mediaType"],
                                         "audiences": ["view"], "delivery": {"kind": "inline", "value": value}}}
            self.move(record, "succeeded", output=output)
        except Exception:
            effect = request["operationId"] != "inventory.stock.list"
            self.move(record, "indeterminate" if effect else "failed",
                      error={"code": "EXECUTION_OUTCOME_UNKNOWN" if effect else "OPERATION_FAILED"})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # No credentials, request values or results in diagnostics.

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def reply(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin")
        if origin and origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def route(self, preflight=False):
        paths = ("/v1/aug/operations", "/v1/aug/invocations", "/v1/aug/invocations/control")
        require(self.path in paths, 404, "NOT_FOUND")
        origin = self.headers.get("Origin")
        require(not origin or origin in self.server.allowed_origins, 403, "ORIGIN_DENIED")
        if preflight:
            return self.reply(204)
        authorization = self.headers.get("Authorization", "")
        actor = ACTORS.get(authorization[7:]) if authorization.startswith("Bearer ") else None
        require(actor is not None, 401, "UNAUTHORIZED")
        require(not self.headers.get("Transfer-Encoding"), 400, "INVALID_JSON")
        length = int(self.headers.get("Content-Length", "0"))
        require(0 <= length <= LIMIT, 413, "REQUEST_TOO_LARGE")
        request = None
        if length:
            require(self.headers.get("Content-Type", "").split(";")[0].strip().lower() == "application/json",
                    415, "UNSUPPORTED_MEDIA_TYPE")
            request = json.loads(self.rfile.read(length).decode("utf-8"), object_pairs_hook=unique_object,
                                 parse_constant=lambda _: require(False, 400, "INVALID_JSON"))
            finite_json(request)
        if self.path == paths[0]:
            return self.reply(200, {"protocolVersion": VERSION, "operations": OPERATIONS if "stock:use" in actor[2] else []})
        result = (self.server.inventory.invoke(actor, request) if self.path == paths[1]
                  else self.server.inventory.control(actor, request))
        self.reply(202 if result["state"] in ("awaiting_confirmation", "running") else 200, result)

    def dispatch(self, preflight=False):
        try:
            self.route(preflight)
        except Refusal as error:
            self.reply(error.status, {"code": error.code, "message": "Request refused"})
        except (ValueError, TypeError, UnicodeError, RecursionError, TimeoutError):
            self.reply(400, {"code": "INVALID_JSON", "message": "Invalid request"})

    def do_POST(self):
        self.dispatch()

    def do_OPTIONS(self):
        self.dispatch(True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4200)
    parser.add_argument("--allow-origin", action="append", default=[])
    args = parser.parse_args()
    # One serial owner: reservation, confirmation and stock changes cannot race.
    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.allowed_origins = set(args.allow_origin)
        server.inventory = Inventory()
        print(json.dumps({"origin": f"http://127.0.0.1:{server.server_port}"}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
