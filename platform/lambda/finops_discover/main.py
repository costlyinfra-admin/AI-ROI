import json
import os
import boto3
import litellm
from datetime import datetime, timedelta, timezone

litellm.drop_params = True

secrets = boto3.client("secretsmanager")
rds = boto3.client("rds-data")

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN  = os.environ["DB_SECRET_ARN"]
DB_NAME        = os.environ.get("DB_NAME", "ciso_copilot")
MODEL          = os.environ.get("FINOPS_DISCOVER_MODEL", "claude-sonnet-4-6")

DISCOVER_PROMPT = """
You are categorising merged pull requests into product features.
A "feature" is a user-facing capability that the company shipped
or worked on. Group these PRs into 3-20 features.

For each feature output a JSON object with:
- name: short, user-facing (string)
- description: one sentence (string)
- pr_label_match: labels that indicate this feature (string[])
- branch_pattern: regex matching branch names (string)
- path_pattern: file path prefixes (string[])
- pr_numbers: PR numbers in this feature (integer[])
- confidence: "high"|"med"|"low"

Return ONLY a JSON array of feature objects. No markdown, no
explanation.
"""

def handler(event, context):
    claims  = event["requestContext"]["authorizer"]["claims"]
    tenant_id = _resolve_tenant_id(claims)

    # Fetch GitHub token for this tenant
    github_token = _get_github_token(tenant_id)
    prs = _fetch_merged_prs(github_token, days=90)

    if len(prs) < 5:
        return _resp(200, {
            "status": "too_sparse",
            "message": "Fewer than 5 PRs in 90 days — define features manually.",
            "features": []
        })

    # Batch into groups of 50
    batches = [prs[i:i+50] for i in range(0, len(prs), 50)]
    all_features = []
    for batch in batches:
        pr_text = json.dumps(batch, default=str)
        resp = litellm.completion(
            model=MODEL,
            messages=[
                {"role": "system", "content": DISCOVER_PROMPT},
                {"role": "user",   "content": pr_text}
            ],
            response_format={"type": "json_object"}
        )
        content = resp.choices[0].message.content
        # Claude may return {"features": [...]} or bare array
        parsed = json.loads(content)
        if isinstance(parsed, list):
            all_features.extend(parsed)
        elif "features" in parsed:
            all_features.extend(parsed["features"])

    return _resp(200, {"status": "ok", "features": all_features})


def _resolve_tenant_id(claims):
    identities = json.loads(claims.get("identities", "[]"))
    subject = identities[0]["userId"] if identities else claims["sub"]
    result = rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql="SELECT tenant_id FROM users WHERE sso_subject = :s",
        parameters=[{"name": "s", "value": {"stringValue": subject}}]
    )
    return result["records"][0][0]["stringValue"]


def _get_github_token(tenant_id):
    # GitHub App installation token — same pattern as existing
    # github_ingest worker. Reads from cloud_connections table.
    result = rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN, secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql="""SELECT credentials_secret_arn FROM cloud_connections
               WHERE tenant_id = :t AND source = 'github'
               LIMIT 1""",
        parameters=[{"name": "t", "value": {"stringValue": tenant_id}}]
    )
    secret_arn = result["records"][0][0]["stringValue"]
    secret = secrets.get_secret_value(SecretId=secret_arn)
    creds = json.loads(secret["SecretString"])
    return creds["token"]


def _fetch_merged_prs(token, days=90):
    import urllib.request
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json"}
    # Simplified: assumes single repo. Production version loops
    # all repos from the tenant's GitHub App installation.
    url = f"https://api.github.com/repos/{{owner}}/{{repo}}/pulls?state=closed&sort=updated&since={since}&per_page=100"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as r:
        prs = json.loads(r.read())
    return [
        {
            "number": pr["number"],
            "title": pr["title"],
            "body": (pr.get("body") or "")[:500],
            "branch": pr["head"]["ref"],
            "labels": [l["name"] for l in pr.get("labels", [])],
            "merged_at": pr.get("merged_at"),
            "author": pr["user"]["login"]
        }
        for pr in prs if pr.get("merged_at")
    ]


def _resp(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*"},
        "body": json.dumps(body, default=str)
    }