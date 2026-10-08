#!/usr/bin/env bash
# Deploys the spend watch function. Safe to run again after a change.
# Needs admin credentials.
#
#   ./deploy.sh                      deploy with a 20 USD limit
#   ./deploy.sh someone@example.com  also subscribe an alert email address
#   LIMIT_USD=40 ./deploy.sh         change the limit
set -euo pipefail
cd "$(dirname "$0")"

export AWS_DEFAULT_REGION=us-east-1
NAME="${NAME:-colosseum-spend-watch}"
IAM_USER="${IAM_USER:-colosseum-deployer}"
TAG_KEY="${TAG_KEY:-project}"
TAG_VALUE="${TAG_VALUE:-colosseum}"
STATE_PARAM="${STATE_PARAM:-/colosseum/spend-watch/state}"
LIMIT_USD="${LIMIT_USD:-20}"
ALERT_EMAIL="${1:-}"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION="${AWS_DEFAULT_REGION}"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${NAME}"
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${NAME}"
LOG_GROUP="/aws/lambda/${NAME}"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

echo "topic"
TOPIC_ARN=$(aws sns create-topic --name "${NAME}" --query TopicArn --output text)
if [ -n "${ALERT_EMAIL}" ]; then
  aws sns subscribe --topic-arn "${TOPIC_ARN}" --protocol email \
    --notification-endpoint "${ALERT_EMAIL}" >/dev/null
fi

echo "role"
cat > "${TMP}/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}
  ]
}
EOF
cat > "${TMP}/policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadResourcesAndMetrics",
      "Effect": "Allow",
      "Action": ["ec2:DescribeInstances", "ec2:DescribeVolumes", "cloudwatch:GetMetricStatistics"],
      "Resource": "*"
    },
    {
      "Sid": "StopTaggedInstances",
      "Effect": "Allow",
      "Action": "ec2:StopInstances",
      "Resource": "arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*",
      "Condition": {"StringEquals": {"aws:ResourceTag/${TAG_KEY}": "${TAG_VALUE}"}}
    },
    {
      "Sid": "PauseAndResumeTheUser",
      "Effect": "Allow",
      "Action": ["iam:AttachUserPolicy", "iam:DetachUserPolicy"],
      "Resource": "arn:aws:iam::${ACCOUNT}:user/${IAM_USER}",
      "Condition": {"ArnEquals": {"iam:PolicyARN": "arn:aws:iam::aws:policy/AWSDenyAll"}}
    },
    {
      "Sid": "State",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:PutParameter"],
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT}:parameter${STATE_PARAM}"
    },
    {
      "Sid": "Alert",
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "${TOPIC_ARN}"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${LOG_GROUP}:*"
    }
  ]
}
EOF
if ! aws iam get-role --role-name "${NAME}" >/dev/null 2>&1; then
  aws iam create-role --role-name "${NAME}" \
    --assume-role-policy-document "file://${TMP}/trust.json" >/dev/null
fi
aws iam put-role-policy --role-name "${NAME}" --policy-name "${NAME}" \
  --policy-document "file://${TMP}/policy.json"

echo "log group"
aws logs create-log-group --log-group-name "${LOG_GROUP}" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "${LOG_GROUP}" --retention-in-days 14

echo "function"
zip -qj "${TMP}/fn.zip" handler.py
ENVIRONMENT="Variables={LIMIT_USD=${LIMIT_USD},IAM_USER=${IAM_USER},TAG_KEY=${TAG_KEY},TAG_VALUE=${TAG_VALUE},STATE_PARAM=${STATE_PARAM},TOPIC_ARN=${TOPIC_ARN}}"
if aws lambda get-function --function-name "${NAME}" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "${NAME}" \
    --zip-file "fileb://${TMP}/fn.zip" >/dev/null
  aws lambda wait function-updated --function-name "${NAME}"
  aws lambda update-function-configuration --function-name "${NAME}" \
    --environment "${ENVIRONMENT}" >/dev/null
else
  # A new role needs some seconds before Lambda can use it.
  for attempt in 1 2 3 4 5 6 7 8; do
    if aws lambda create-function --function-name "${NAME}" \
      --runtime python3.13 --architectures arm64 --handler handler.handler \
      --role "${ROLE_ARN}" --timeout 60 --memory-size 256 \
      --environment "${ENVIRONMENT}" \
      --zip-file "fileb://${TMP}/fn.zip" >/dev/null 2>"${TMP}/err"; then
      break
    fi
    if [ "${attempt}" = 8 ]; then cat "${TMP}/err"; exit 1; fi
    sleep 5
  done
fi
aws lambda wait function-updated --function-name "${NAME}"

echo "schedule"
RULE_ARN=$(aws events put-rule --name "${NAME}" \
  --schedule-expression "rate(1 minute)" --query RuleArn --output text)
aws lambda add-permission --function-name "${NAME}" --statement-id events \
  --action lambda:InvokeFunction --principal events.amazonaws.com \
  --source-arn "${RULE_ARN}" >/dev/null 2>&1 || true
aws events put-targets --rule "${NAME}" --targets "Id=1,Arn=${FN_ARN}" >/dev/null

echo "done: ${NAME}, limit ${LIMIT_USD} USD"
