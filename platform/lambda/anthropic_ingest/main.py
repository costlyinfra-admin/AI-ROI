import json, os, uuid
from datetime import datetime, timedelta, timezone
import boto3
import urllib.request

secrets = boto3.client("secretsmanager")
rds     = boto3.client("rds-data")

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN  = os.environ["DB_SECRET_ARN"]
DB_NAME        = os.environ.get("DB_NAME", "ciso_copilot")
ANTHROPIC_KEY_SECRET = os.environ["ANTHROPIC_ADMIN_KEY_SECRET_ARN"]


def handler(event, context):
    api_key = _get_secret(ANTHROPIC_KEY_SECRET)
    tenants = _list_tenants_with_anthropic()

    for tenant_id in tenants:
        _ingest_for_tenant(tenant_id, api_key)

    return {"status": "ok"}


def _ingest_for_tenant(tenant_id, api_key):
    # Fetch last ingest timestamp (stored in feature_signals metadata)
    since = _last_ingest_time(tenant_id)
    usage_rows = _fetch_anthropic_usage(api_key, since)

    for row in usage_rows:
        # Try to resolve feature from GitHub branch activity
        feature_id, confidence = _resolve_feature(
            tenant_id, row["user_email"], row["timestamp"]
        )

        signal_id = str(uuid.uuid4())
        cost_id   = str(uuid.uuid4())

        # Write signal
        _sql(
            """INSERT INTO feature_signals
                 (signal_id, tenant_id, feature_id, occurred_at,
                  source, external_ref, actor, signal_kind,
                  confidence, evidence_packet)
               VALUES
                 (:sid, :tid, :fid, :ts,
                  'anthropic', :ref, :actor, 'llm-call-dev',
                  :conf, :ep)""",
            [
                {"name": "sid",   "value": {"stringValue": signal_id}},
                {"name": "tid",   "value": {"stringValue": tenant_id}},
                {"name": "fid",   "value": {"stringValue": feature_id} if feature_id else {"isNull": True}},
                {"name": "ts",    "value": {"stringValue": row["timestamp"]}},
                {"name": "ref",   "value": {"stringValue": row.get("request_id", "")}},
                {"name": "actor", "value": {"stringValue": row["user_email"]}},
                {"name": "conf",  "value": {"stringValue": confidence}},
                {"name": "ep",    "value": {"stringValue": json.dumps(row)}},
            ]
        )

        # Write cost
        _sql(
            """INSERT INTO feature_costs
                 (cost_id, tenant_id, feature_id, signal_id,
                  occurred_at, phase, source, actor, model,
                  tokens_in, tokens_out, cost_usd, confidence,
                  evidence_packet)
               VALUES
                 (:cid, :tid, :fid, :sid,
                  :ts, 'build', 'anthropic', :actor, :model,
                  :tin, :tout, :cost, :conf, :ep)""",
            [
                {"name": "cid",   "value": {"stringValue": cost_id}},
                {"name": "tid",   "value": {"stringValue": tenant_id}},
                {"name": "fid",   "value": {"stringValue": feature_id} if feature_id else {"isNull": True}},
                {"name": "sid",   "value": {"stringValue": signal_id}},
                {"name": "ts",    "value": {"stringValue": row["timestamp"]}},
                {"name": "actor", "value": {"stringValue": row["user_email"]}},
                {"name": "model", "value": {"stringValue": row.get("model", "")}},
                {"name": "tin",   "value": {"longValue": row.get("input_tokens", 0)}},
                {"name": "tout",  "value": {"longValue": row.get("output_tokens", 0)}},
                {"name": "cost",  "value": {"stringValue": str(row.get("cost_usd", 0))}},
                {"name": "conf",  "value": {"stringValue": confidence}},
                {"name": "ep",    "value": {"stringValue": json.dumps({
                    "resolution": "github-branch-time-window",
                    "feature_id": feature_id,
                    "confidence": confidence
                })}},
            ]
        )


def _resolve_feature(tenant_id, actor_email, timestamp):
    """
    Find which feature the actor was working on at `timestamp`.
    Strategy: look for open PRs by this actor within ±4h of timestamp.
    Returns (feature_id|None, confidence).
    """
    result = _sql(
        """SELECT DISTINCT fs.feature_id
           FROM feature_signals fs
           WHERE fs.tenant_id = :t
             AND fs.actor = :actor
             AND fs.source = 'github'
             AND fs.occurred_at BETWEEN
               (:ts::timestamptz - interval '4 hours')
               AND
               (:ts::timestamptz + interval '4 hours')
             AND fs.feature_id IS NOT NULL""",
        [
            {"name": "t",     "value": {"stringValue": tenant_id}},
            {"name": "actor", "value": {"stringValue": actor_email}},
            {"name": "ts",    "value": {"stringValue": timestamp}},
        ]
    )
    matches = [r[0]["stringValue"] for r in result["records"]]
    if len(matches) == 1:
        return matches[0], "high"
    elif len(matches) > 1:
        # Multiple features — return None with med confidence;
        # the caller writes feature_id=NULL and surfaces in triage
        return None, "med"
    else:
        return None, "low"


def _fetch_anthropic_usage(api_key, since):
    """
    Call Anthropic Admin API: GET /v1/organizations/usage_report/messages
    Returns list of usage rows.
    """
    since_str = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    url = (f"https://api.anthropic.com/v1/organizations/usage_report/messages"
           f"?start_time={since_str}&limit=1000")
    req = urllib.request.Request(url, headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01"
    })
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())
    return data.get("data", [])


def _last_ingest_time(tenant_id):
    result = _sql(
        """SELECT MAX(occurred_at) FROM feature_signals
           WHERE tenant_id = :t AND source = 'anthropic'""",
        [{"name": "t", "value": {"stringValue": tenant_id}}]
    )
    val = result["records"][0][0].get("stringValue")
    if val:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    return datetime.now(timezone.utc) - timedelta(days=90)


def _list_tenants_with_anthropic():
    result = _sql(
        """SELECT DISTINCT tenant_id FROM cloud_connections
           WHERE source = 'anthropic' AND status = 'active'""", []
    )
    return [r[0]["stringValue"] for r in result["records"]]


def _get_secret(arn):
    return secrets.get_secret_value(SecretId=arn)["SecretString"]


def _sql(sql, params):
    return rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN,
        database=DB_NAME, sql=sql, parameters=params
    )