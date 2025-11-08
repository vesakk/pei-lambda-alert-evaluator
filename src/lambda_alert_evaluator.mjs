// src/lambda_alert_evaluator.mjs
// Node.js 20+, ES Modules
//
// DynamoDB Streams (sensor_data) -> arvioi hälytysrajat (per käyttäjätilaus ja metriikka).
// - Tilaukset alert_subscriptions (PK=sensorId, SK=userSub).
// - Tila alert_state (PK=`${sensorId}#${metric}`, SK=userSub).
// - Kanavat: email (SESv2), sms (SNS Publish PhoneNumber).
//
// Env: SUBS_TABLE, STATE_TABLE, SES_FROM

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const SUBS_TABLE = process.env.SUBS_TABLE || "alert_subscriptions";
const STATE_TABLE = process.env.STATE_TABLE || "alert_state";
const SES_FROM = process.env.SES_FROM || "";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const sns = new SNSClient({});
const ses = new SESv2Client({});

// ---- Utils ----
const nowIso = () => new Date().toISOString();
const isoToMs = (iso) => (iso ? Date.parse(iso) : 0);

/** Palauta { sensorId, ts, measurements: {metric:number,...} } DynamoDB Streams NewImage:stä */
function parseNewImage(newImage) {
  if (!newImage) return null;
  const sensorId = newImage.sensorId?.S;
  const ts = newImage.ts?.N ? Number(newImage.ts.N) : undefined;
  if (!sensorId || !ts) return null;
  const measurements = {};
  for (const [k, v] of Object.entries(newImage)) {
    if (k === "sensorId" || k === "ts") continue;
    if (v && typeof v === "object" && "N" in v) {
      const num = Number(v.N);
      if (!Number.isNaN(num)) measurements[k] = num;
    }
  }
  return { sensorId, ts, measurements };
}

async function fetchSubscriptions(sensorId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: SUBS_TABLE,
      KeyConditionExpression: "sensorId = :sid",
      ExpressionAttributeValues: { ":sid": sensorId },
    })
  );
  return Array.isArray(res.Items) ? res.Items : [];
}

async function getPrevState(pk, sk) {
  const out = await ddb.send(
    new GetCommand({
      TableName: STATE_TABLE,
      Key: { pk, sk },
    })
  );
  return out?.Item;
}

async function putState(pk, sk, state, lastNotifiedAt = null) {
  await ddb.send(
    new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk,
        sk,
        lastState: state,
        lastNotifiedAt,
      },
    })
  );
}

function withinCooldown(lastNotifiedAtIso, cooldownSec) {
  if (!cooldownSec || cooldownSec <= 0) return false;
  const last = isoToMs(lastNotifiedAtIso);
  if (!last) return false;
  return Date.now() - last < cooldownSec * 1000;
}

function evalState({ value, thresholds, prevState }) {
  if (!thresholds) return null; // ei thresholdia -> ei tutkita
  const min = thresholds.min;
  const max = thresholds.max;
  const hys = thresholds.hysteresis ?? 0;

  // raaka-tila ilman hystereesiä
  let raw;
  if (typeof max === "number" && value > max) raw = "high";
  else if (typeof min === "number" && value < min) raw = "low";
  else raw = "ok";

  if (!prevState || prevState === raw) return raw;

  // hystereesi: pysy high kunnes pudotaan max - hys; pysy low kunnes noustaan min + hys
  if (prevState === "high") {
    if (typeof max === "number" && value > (max - hys)) return "high";
    return "ok";
  }
  if (prevState === "low") {
    if (typeof min === "number" && value < (min + hys)) return "low";
    return "ok";
  }
  return raw;
}

function buildMessage({ sensorId, metric, val, state, ts }) {
  const when = new Date(ts).toISOString();
  const subject = `[PEI] ${sensorId} ${metric} ${state.toUpperCase()}: ${val}`;
  const body = `Sensor: ${sensorId}
Metric: ${metric}
Value: ${val}
State: ${state}
At: ${when}`;
  return { subject, body };
}

async function notifyChannels({ channels, email, phone, subject, body }) {
  const errors = [];
  
  if (channels?.includes("email") && email && SES_FROM) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: SES_FROM,
            Destination: { ToAddresses: [email] },
            Content: {
              Simple: { Subject: { Data: subject }, Body: { Text: { Data: body } } },
            },
          })
        );
        console.log(`Email sent to ${email}`);
        break;
      } catch (err) {
        if (attempt === 2) errors.push(`Email failed: ${err.message}`);
      }
    }
  }
  
  if (channels?.includes("sms") && phone) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await sns.send(
          new PublishCommand({
            PhoneNumber: phone,
            Message: body,
          })
        );
        console.log(`SMS sent to ${phone}`);
        break;
      } catch (err) {
        if (attempt === 2) errors.push(`SMS failed: ${err.message}`);
      }
    }
  }
  
  if (errors.length) throw new Error(errors.join("; "));
}

async function processRecord(rec) {
  // Vain INSERT
  if (rec?.eventName !== "INSERT") return;

  const parsed = parseNewImage(rec?.dynamodb?.NewImage);
  if (!parsed) return;

  const { sensorId, ts, measurements } = parsed;
  const metricKeys = Object.keys(measurements);
  if (metricKeys.length === 0) return; // tyhjät mittaukset -> ei mitään

  // Hae tilaukset vasta nyt (on jotain mitattavaa)
  const subs = await fetchSubscriptions(sensorId);
  if (!subs.length) return;

  for (const metric of metricKeys) {
    const val = measurements[metric];
    for (const sub of subs) {
      if (!sub?.active) continue;
      const thresholds = sub?.thresholds?.[metric];
      if (!thresholds) continue; // ei thresholdia tälle metrille

      const pk = `${sensorId}#${metric}`;
      const sk = sub.userSub;

      const prev = await getPrevState(pk, sk);
      const prevState = prev?.lastState;

      const curState = evalState({ value: val, thresholds, prevState });
      if (!curState) continue; // varmistus

      const changed = (!prevState || prevState !== curState);
      const isAlarm = curState === "low" || curState === "high";
      const cooldownActive = withinCooldown(prev?.lastNotifiedAt, sub?.cooldownSec);
      const shouldNotify = isAlarm && (changed || !cooldownActive);

      if (shouldNotify) {
        const { subject, body } = buildMessage({
          sensorId, metric, val, state: curState, ts
        });
        try {
          await notifyChannels({
            channels: sub.channels,
            email: sub.email,
            phone: sub.phone_number,
            subject,
            body,
          });
          await putState(pk, sk, curState, nowIso());
          console.log(`Alert sent: ${sensorId}#${metric} ${curState} to ${sub.userSub}`);
        } catch (err) {
          console.error(`Notification failed for ${sub.userSub}:`, err.message);
          // Päivitä tila ilman lastNotifiedAt, jotta seuraavalla kerralla yritetään uudelleen
          await putState(pk, sk, curState, prev?.lastNotifiedAt || null);
        }
      } else if (changed || (isAlarm && cooldownActive)) {
        // Päivitä tila: muutos tai hälytys cooldownissa
        await putState(pk, sk, curState, prev?.lastNotifiedAt || null);
      }
    }
  }
}

export const handler = async (event) => {
  const records = Array.isArray(event?.Records) ? event.Records : [];
  const results = await Promise.allSettled(
    records.map(rec => processRecord(rec))
  );
  
  const failed = results.filter(r => r.status === "rejected");
  if (failed.length) {
    failed.forEach((f, i) => 
      console.error(`Record ${i} failed:`, f.reason)
    );
  }
  
  return { 
    ok: true, 
    processed: records.length, 
    failed: failed.length 
  };
};
