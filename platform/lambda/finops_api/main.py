import json, os, uuid
import boto3

rds = boto3.client("rds-data")
DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN  = os.environ["DB_SECRET_ARN"]
DB_NAME        = os.environ.get("DB_NAME", "ciso_copilot")


def handler(event, context):
    method = event["httpMethod"]
    path   = event["path"]
    claims = event["requestContext"]["authorizer"]["claims"]
    tenant_id = _resolve_tenant_id(claims)

    if method == "GET"  and path == "/v1/finops/features":
        return list_features(tenant_id)
    if method == "POST" and path == "/v1/finops/features":
        return create_feature(tenant_id, json.loads(event["body"] or "{}"))
    if method == "POST" and "/confirm" in path:
        feature_id = path.split("/")[-2]
        return confirm_feature(tenant_id, feature_id,
                               json.loads(event["body"] or "{}"))
    if method == "PUT"  and "/features/" in path:
        feature_id = path.split("/")[-1]
        return update_feature(tenant_id, feature_id,
                              json.loads(event["body"] or "{}"))
    if method == "GET"  and path == "/v1/finops/costs":
        return list_costs(tenant_id, event.get("queryStringParameters") or {})

    return _resp(404, {"message": "Not found"})


def list_features(tenant_id):
    result = _sql(
        """SELECT feature_id, name, description, status, shipped_at,
                  github_pr_labels, github_branch_re, sdk_tags
           FROM features
           WHERE tenant_id = :t
           ORDER BY created_at DESC""",
        [{"name": "t", "value": {"stringValue": tenant_id}}]
    )
    features = [_row_to_feature(r) for r in result["records"]]
    return _resp(200, {"features": features})


def create_feature(tenant_id, body):
    feature_id = str(uuid.uuid4())
    _sql(
        """INSERT INTO features
             (feature_id, tenant_id, name, description, status,
              github_pr_labels, github_branch_re, sdk_tags)
           VALUES
             (:fid, :tid, :name, :desc, :status,
              :labels, :branch_re, :sdk_tags)""",
        [
            {"name": "fid",       "value": {"stringValue": feature_id}},
            {"name": "tid",       "value": {"stringValue": tenant_id}},
            {"name": "name",      "value": {"stringValue": body["name"]}},
            {"name": "desc",      "value": {"stringValue": body.get("description", "")}},
            {"name": "status",    "value": {"stringValue": body.get("status", "in-dev")}},
            {"name": "labels",    "value": {"stringValue": json.dumps(body.get("github_pr_labels", []))}},
            {"name": "branch_re", "value": {"stringValue": body.get("github_branch_re", "")}},
            {"name": "sdk_tags",  "value": {"stringValue": json.dumps(body.get("sdk_tags", []))}},
        ]
    )
    return _resp(201, {"feature_id": feature_id})


def confirm_feature(tenant_id, feature_id, body):
    """Persist a feature from auto-discovery draft and seed signals."""
    # body contains the AI-proposed feature including pr_numbers
    pr_numbers = body.get("pr_numbers", [])
    create_feature(tenant_id, body)

    # Seed feature_signals for confirmed PRs
    for pr_num in pr_numbers:
        signal_id = str(uuid.uuid4())
        _sql(
            """INSERT INTO feature_signals
                 (signal_id, tenant_id, feature_id, occurred_at,
                  source, external_ref, signal_kind, confidence,
                  evidence_packet)
               VALUES
                 (:sid, :tid, :fid, now(),
                  'github', :ref, 'pr-merged', 'high',
                  :ep)""",
            [
                {"name": "sid", "value": {"stringValue": signal_id}},
                {"name": "tid", "value": {"stringValue": tenant_id}},
                {"name": "fid", "value": {"stringValue": feature_id}},
                {"name": "ref", "value": {"stringValue": str(pr_num)}},
                {"name": "ep",  "value": {"stringValue": json.dumps(
                    {"pr_number": pr_num, "source": "auto-discovery",
                     "confirmed_by_user": True}
                )}},
            ]
        )
    return _resp(200, {"status": "confirmed", "feature_id": feature_id,
                       "signals_seeded": len(pr_numbers)})


def list_costs(tenant_id, params):
    days = int(params.get("days", 30))
    result = _sql(
        """SELECT fc.feature_id, f.name,
                  SUM(fc.cost_usd) as total_cost,
                  COUNT(*) as call_count,
                  fc.phase,
                  MIN(fc.confidence) as min_confidence
           FROM feature_costs fc
           LEFT JOIN features f
             ON fc.feature_id = f.feature_id
           WHERE fc.tenant_id = :t
             AND fc.occurred_at > now() - (:days || ' days')::interval
           GROUP BY fc.feature_id, f.name, fc.phase
           ORDER BY total_cost DESC""",
        [
            {"name": "t",    "value": {"stringValue": tenant_id}},
            {"name": "days", "value": {"longValue": days}},
        ]
    )
    rows = [
        {
            "feature_id":   r[0].get("stringValue"),
            "feature_name": r[1].get("stringValue", "Unattributed"),
            "total_cost":   float(r[2].get("stringValue", 0)),
            "call_count":   r[3].get("longValue", 0),
            "phase":        r[4].get("stringValue"),
            "confidence":   r[5].get("stringValue", "low"),
        }
        for r in result["records"]
    ]
    return _resp(200, {"costs": rows})


def update_feature(tenant_id, feature_id, body):
    _sql(
        """UPDATE features
           SET name           = COALESCE(:name, name),
               description    = COALESCE(:desc, description),
               status         = COALESCE(:status, status),
               github_branch_re = COALESCE(:branch_re, github_branch_re)
           WHERE feature_id = :fid AND tenant_id = :tid""",
        [
            {"name": "name",      "value": {"stringValue": body.get("name", "")} if body.get("name") else {"isNull": True}},
            {"name": "desc",      "value": {"stringValue": body.get("description", "")} if body.get("description") else {"isNull": True}},
            {"name": "status",    "value": {"stringValue": body.get("status", "")} if body.get("status") else {"isNull": True}},
            {"name": "branch_re", "value": {"stringValue": body.get("github_branch_re", "")} if body.get("github_branch_re") else {"isNull": True}},
            {"name": "fid",       "value": {"stringValue": feature_id}},
            {"name": "tid",       "value": {"stringValue": tenant_id}},
        ]
    )
    return _resp(200, {"status": "updated"})


def _resolve_tenant_id(claims):
    identities = json.loads(claims.get("identities", "[]"))
    subject = identities[0]["userId"] if identities else claims["sub"]
    result = _sql(
        "SELECT tenant_id FROM users WHERE sso_subject = :s",
        [{"name": "s", "value": {"stringValue": subject}}]
    )
    return result["records"][0][0]["stringValue"]


def _sql(sql, params):
    return rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN,
        database=DB_NAME, sql=sql, parameters=params
    )


def _row_to_feature(r):
    return {
        "feature_id":       r[0].get("stringValue"),
        "name":             r[1].get("stringValue"),
        "description":      r[2].get("stringValue"),
        "status":           r[3].get("stringValue"),
        "shipped_at":       r[4].get("stringValue"),
        "github_pr_labels": json.loads(r[5].get("stringValue", "[]")),
        "github_branch_re": r[6].get("stringValue"),
        "sdk_tags":         json.loads(r[7].get("stringValue", "[]")),
    }


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body, default=str)
    }