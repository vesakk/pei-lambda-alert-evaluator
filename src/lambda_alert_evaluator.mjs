// Node.js 20+ (ESM)
// Event source: DynamoDB Streams (sensor_data) -> tämä Lambda arvioi hälytysrajat
// Env: SUBS_TABLE=alert_subscriptions, STATE_TABLE=alert_state, SES_FROM=noreply@domain.tld
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
const SES_FROM = process.env.SES_FROM || ""; // pitää olla SES-identity (domain/osoite)

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const sns = new SNSClient({});
const ses = new SESv2Client({});

export const handler = async (event) => {
  try {
    const records = Array.isArray(event?.Records) ? event.Records : [];
    for (const rec of records) {
      if (rec.eventName === "REMOVE") continue;

      const img = rec.dynamodb?.NewImage;
      if (!img) continue;

      const sensorId = img.sensorId?.S || img.sensorId?.s || null;
      if (!sensorId) continue;

      const ts = img.ts?.N ? Number(img.ts.N) : Date.now();

      // Poimi kaikki numeeriset mittauskentät (pl. ts)
      const measurements = {};
      for (const [k, v] of Object.entries(img)) {
        if (k === "ts") continue;
        if (v?.N) {
          const num = Number(v.N);
          if (Number.isFinite(num)) measurements[k] = num;
        }
      }
      if (!Object.keys(measurements).length) continue;

      // Hae tilaajat sensorille
      const subsResp = await ddb.send(
        new QueryCommand({
          TableName: SUBS_TABLE,
          KeyConditionExpression: "sensorId = :s",
          ExpressionAttributeValues: { ":s": sensorId },
        })
      );

      const subs = subsResp.Items || [];
      for (const s of subs) {
        if (s?.active === false) continue;

        const channels = Array.isArray(s?.channels) ? s.channels : [];
        const thresholds = s?.thresholds || {};
        const userSub = s?.userSub;
        const cooldown = Number.isFinite(s?.cooldownSec) ? s.cooldownSec : 1800;

        for (const [metric, value] of Object.entries(measurements)) {
          const thr = thresholds[metric];
          if (!thr) continue;

          const state = classify(value, thr); // "ok" | "low" | "high"
          const key = { pk: `${sensorId}#${metric}`, sk: userSub };
          const prev = await ddb.send(
            new GetCommand({ TableName: STATE_TABLE, Key: key })
          );

          const now = Date.now();
          const last =
            prev.Item?.lastNotifiedAt ? Date.parse(prev.Item.lastNotifiedAt) : 0;
          const changed = state !== (prev.Item?.lastState ?? "ok");
          const cooled = (now - last) / 1000 >= cooldown;

          if (state !== "ok" && (changed || cooled)) {
            const subject = `Alert ${sensorId} ${metric} ${state.toUpperCase()}`;
            const msg = `[${sensorId}] ${metric} ${state.toUpperCase()} value=${value} ts=${ts}`;

            // Suosittelen tallettamaan s.email / s.phone_number tilaajaan.
            if (channels.includes("sms") && s?.phone_number) {
              await sns.send(
                new PublishCommand({ PhoneNumber: s.phone_number, Message: msg })
              );
            }
            if (channels.includes("email") && s?.email && SES_FROM) {
              await ses.send(
                new SendEmailCommand({
                  FromEmailAddress: SES_FROM,
                  Destination: { ToAddresses: [s.email] },
                  Content: {
                    Simple: {
                      Subject: { Data: subject },
                      Body: { Text: { Data: msg } },
                    },
                  },
                })
              );
            }

            await ddb.send(
              new PutCommand({
                TableName: STATE_TABLE,
                Item: {
                  ...key,
                  lastNotifiedAt: new Date(now).toISOString(),
                  lastState: state,
                },
              })
            );
          } else if (state === "ok" && changed) {
            // Paluu normaaliin tilaan
            await ddb.send(
              new PutCommand({
                TableName: STATE_TABLE,
                Item: {
                  ...key,
                  lastNotifiedAt: new Date().toISOString(),
                  lastState: "ok",
                },
              })
            );
          }
        }
      }
    }

    return { ok: true, processed: (event?.Records || []).length };
  } catch (err) {
    console.error("Alert evaluator error:", err);
    return { ok: false, error: String(err?.message || err) };
  }
};

// ---------- Apurit ----------
function classify(value, thr) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "ok";
  const h = Number.isFinite(thr?.hysteresis) ? Number(thr.hysteresis) : 0;
  if (thr?.min !== undefined && value < Number(thr.min) - h) return "low";
  if (thr?.max !== undefined && value > Number(thr.max) + h) return "high";
  return "ok";
}
