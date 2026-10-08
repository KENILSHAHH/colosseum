"""Spend watch for one IAM user.

Runs each minute. AWS billing data is hours late, so this function estimates
the month-to-date cost from live resource state: it reads all resources with
the project tag, calculates their cost per hour, and adds that cost for the
time since the last run.

When the estimate reaches LIMIT_USD it pauses the user: it attaches AWSDenyAll
to the user and stops the tagged instances. It removes the pause when the
estimate is below the limit again (new month, or a higher LIMIT_USD).
"""
import json
import os
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

LIMIT_USD = float(os.environ["LIMIT_USD"])
IAM_USER = os.environ["IAM_USER"]
TAG_KEY = os.environ["TAG_KEY"]
TAG_VALUE = os.environ["TAG_VALUE"]
STATE_PARAM = os.environ["STATE_PARAM"]
TOPIC_ARN = os.environ.get("TOPIC_ARN", "")
DENY_ALL = "arn:aws:iam::aws:policy/AWSDenyAll"

# us-east-1 on-demand prices in USD. Free tier is ignored, so the estimate is
# equal to or higher than the bill.
INSTANCE_HOUR = {"t4g.nano": 0.0042, "t4g.micro": 0.0084, "t4g.small": 0.0168}
UNKNOWN_INSTANCE_HOUR = 0.10
# T4g instances bill extra CPU above this baseline (percent per vCPU).
CPU_BASELINE = {"t4g.nano": 5.0, "t4g.micro": 10.0, "t4g.small": 20.0}
VCPUS = 2
SURPLUS_VCPU_HOUR = 0.04
PUBLIC_IP_HOUR = 0.005
VOLUME_GB_MONTH = {"gp3": 0.08}
DEFAULT_VOLUME_GB_MONTH = 0.10
EGRESS_GB = 0.09
HOURS_PER_MONTH = 730
# A longer gap means the function did not run. Do not bill the gap blindly.
MAX_GAP_HOURS = 1.0

ec2 = boto3.client("ec2")
cloudwatch = boto3.client("cloudwatch")
iam = boto3.client("iam")
ssm = boto3.client("ssm")
sns = boto3.client("sns")

TAG_FILTER = {"Name": f"tag:{TAG_KEY}", "Values": [TAG_VALUE]}


def load_state(now):
    try:
        value = ssm.get_parameter(Name=STATE_PARAM)["Parameter"]["Value"]
        return json.loads(value)
    except ClientError as err:
        if err.response["Error"]["Code"] != "ParameterNotFound":
            raise
    return {"month": now.strftime("%Y-%m"), "spent": 0.0, "last": now.isoformat(), "paused": False}


def save_state(state):
    ssm.put_parameter(Name=STATE_PARAM, Value=json.dumps(state), Type="String", Overwrite=True)


def tagged_instances():
    states = {"Name": "instance-state-name", "Values": ["pending", "running"]}
    pages = ec2.get_paginator("describe_instances").paginate(Filters=[TAG_FILTER, states])
    return [i for page in pages for r in page["Reservations"] for i in r["Instances"]]


def tagged_volumes():
    pages = ec2.get_paginator("describe_volumes").paginate(Filters=[TAG_FILTER])
    return [v for page in pages for v in page["Volumes"]]


def latest_datapoint(metric, instance_id, statistic, now):
    points = cloudwatch.get_metric_statistics(
        Namespace="AWS/EC2",
        MetricName=metric,
        Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
        StartTime=now - timedelta(minutes=20),
        EndTime=now,
        Period=300,
        Statistics=[statistic],
    )["Datapoints"]
    if not points:
        return 0.0
    return max(points, key=lambda p: p["Timestamp"])[statistic]


def instance_hour_rate(instance, now):
    kind = instance["InstanceType"]
    rate = INSTANCE_HOUR.get(kind, UNKNOWN_INSTANCE_HOUR)
    if instance.get("PublicIpAddress"):
        rate += PUBLIC_IP_HOUR
    cpu = latest_datapoint("CPUUtilization", instance["InstanceId"], "Average", now)
    surplus = max(0.0, cpu - CPU_BASELINE.get(kind, 100.0)) / 100
    rate += surplus * VCPUS * SURPLUS_VCPU_HOUR
    # NetworkOut is bytes per 5 minutes. 12 periods make one hour.
    out_bytes = latest_datapoint("NetworkOut", instance["InstanceId"], "Sum", now)
    rate += out_bytes * 12 / 1e9 * EGRESS_GB
    return rate


def volume_hour_rate(volume):
    per_month = VOLUME_GB_MONTH.get(volume["VolumeType"], DEFAULT_VOLUME_GB_MONTH)
    return volume["Size"] * per_month / HOURS_PER_MONTH


def hours_left_in_month(now):
    next_month = (now.replace(day=1) + timedelta(days=32)).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    return (next_month - now).total_seconds() / 3600


def notify(subject, body):
    if not TOPIC_ARN:
        return
    try:
        sns.publish(TopicArn=TOPIC_ARN, Subject=subject, Message=body)
    except ClientError as err:
        print(f"notify failed: {err}")


def stop_instances(instances):
    stopped = []
    for instance in instances:
        try:
            ec2.stop_instances(InstanceIds=[instance["InstanceId"]])
            stopped.append(instance["InstanceId"])
        except ClientError as err:
            # A pending instance cannot stop yet. The next run stops it.
            print(f"stop failed for {instance['InstanceId']}: {err}")
    return stopped


def handler(event, context):
    now = datetime.now(timezone.utc)
    month = now.strftime("%Y-%m")
    state = load_state(now)
    if state["month"] != month:
        state.update(month=month, spent=0.0, last=now.isoformat())

    gap_hours = (now - datetime.fromisoformat(state["last"])).total_seconds() / 3600
    gap_hours = min(max(gap_hours, 0.0), MAX_GAP_HOURS)

    instances = tagged_instances()
    run_rate = sum(instance_hour_rate(i, now) for i in instances)
    disk_rate = sum(volume_hour_rate(v) for v in tagged_volumes())
    state["spent"] += (run_rate + disk_rate) * gap_hours
    state["last"] = now.isoformat()

    # A stopped instance still pays for its disk until the month ends. Count
    # that cost now, so the pause comes before the limit and not after it.
    committed = state["spent"] + disk_rate * hours_left_in_month(now)
    over = committed >= LIMIT_USD
    stopped = []

    if over:
        if not state["paused"]:
            iam.attach_user_policy(UserName=IAM_USER, PolicyArn=DENY_ALL)
            state["paused"] = True
            notify(
                f"AWS user {IAM_USER} is paused",
                f"The estimated cost for {month} is {committed:.2f} USD. "
                f"The limit is {LIMIT_USD:.2f} USD. The user has no access now, "
                f"and the servers with the tag {TAG_KEY}={TAG_VALUE} are stopped.",
            )
        # Run on each pass, so an instance that was pending also stops.
        stopped = stop_instances(instances)
    elif state["paused"]:
        try:
            iam.detach_user_policy(UserName=IAM_USER, PolicyArn=DENY_ALL)
        except ClientError as err:
            if err.response["Error"]["Code"] != "NoSuchEntity":
                raise
        state["paused"] = False
        notify(
            f"AWS user {IAM_USER} has access again",
            f"The estimated cost for {month} is {committed:.2f} USD. "
            f"The limit is {LIMIT_USD:.2f} USD. The servers stay stopped. "
            f"The user must start them.",
        )

    save_state(state)
    summary = {
        "month": month,
        "spent_usd": round(state["spent"], 4),
        "committed_usd": round(committed, 4),
        "limit_usd": LIMIT_USD,
        "rate_usd_per_hour": round(run_rate + disk_rate, 5),
        "running_instances": len(instances),
        "paused": state["paused"],
        "stopped_now": stopped,
    }
    print(json.dumps(summary))
    return summary
