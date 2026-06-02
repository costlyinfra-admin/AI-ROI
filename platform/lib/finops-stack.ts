// Lambdas
const finopsApi = new lambda.Function(this, "FinopsApi", {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: "main.handler",
  code: lambda.Code.fromAsset("lambda/finops_api"),
  environment: {
    DB_CLUSTER_ARN: props.dbClusterArn,
    DB_SECRET_ARN:  props.dbSecretArn,
    DB_NAME:        "ciso_copilot",
  },
  timeout: Duration.seconds(30),
});

const finopsDiscover = new lambda.Function(this, "FinopsDiscover", {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: "main.handler",
  code: lambda.Code.fromAsset("lambda/finops_discover"),
  environment: {
    DB_CLUSTER_ARN: props.dbClusterArn,
    DB_SECRET_ARN:  props.dbSecretArn,
    DB_NAME:        "ciso_copilot",
    FINOPS_DISCOVER_MODEL: "claude-sonnet-4-6",
  },
  timeout: Duration.seconds(120),  // Sonnet call can take a while
});

const anthropicIngest = new lambda.Function(this, "AnthropicIngest", {
  runtime: lambda.Runtime.PYTHON_3_12,
  handler: "main.handler",
  code: lambda.Code.fromAsset("lambda/anthropic_ingest"),
  environment: {
    DB_CLUSTER_ARN:              props.dbClusterArn,
    DB_SECRET_ARN:               props.dbSecretArn,
    DB_NAME:                     "ciso_copilot",
    ANTHROPIC_ADMIN_KEY_SECRET_ARN: anthropicKeySecret.secretArn,
  },
  timeout: Duration.seconds(300),
});

// Grant Data API access
props.dbSecret.grantRead(finopsApi);
props.dbSecret.grantRead(finopsDiscover);
props.dbSecret.grantRead(anthropicIngest);
anthropicKeySecret.grantRead(finopsDiscover);
anthropicKeySecret.grantRead(anthropicIngest);

// API Gateway routes (add to existing RestApi)
const finops = api.root.addResource("v1").addResource("finops");
finops.addResource("features").addMethod("GET",
  new apigw.LambdaIntegration(finopsApi), { authorizer });
finops.addResource("features").addMethod("POST",
  new apigw.LambdaIntegration(finopsApi), { authorizer });
finops.addResource("features").addResource("discover").addMethod("POST",
  new apigw.LambdaIntegration(finopsDiscover), { authorizer });
finops.addResource("costs").addMethod("GET",
  new apigw.LambdaIntegration(finopsApi), { authorizer });

// EventBridge rule — 6h ingest cadence
const ingestRule = new events.Rule(this, "AnthropicIngestRule", {
  schedule: events.Schedule.rate(Duration.hours(6)),
});
ingestRule.addTarget(new targets.LambdaFunction(anthropicIngest));