// file: test/lambda_alert_evaluator.test.mjs
import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";

import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

let handler; // dynaaminen import myöhemmin

// ---- Mocks ----
const ddbMock = mockClient(DynamoDBDocumentClient);
const snsMock = mockClient(SNSClient);
const sesMock = mockClient(SESv2Client);

// ---- Helpers ----
function ddbNumber(n) { return { N: String(n) }; }
function ddbString(s) { return { S: String(s) }; }

function streamEvent({ sensorId = "elt-1", ts = Date.now(), measurements = {} } = {}) {
  const NewImage = { sensorId: ddbString(sensorId), ts: ddbNumber(ts) };
  for (const [k, v] of Object.entries(measurements)) {
    if (typeof v === "number") NewImage[k] = ddbNumber(v);
  }
  return {
    Records: [
      {
        eventName: "INSERT",
        dynamodb: { NewImage },
      },
    ],
  };
}

function removeEvent() {
  return { Records: [ { eventName: "REMOVE", dynamodb: {} } ] };
}

function subsItem({
  userSub = "u1",
  active = true,
  channels = ["email", "sms"],
  email = "test@example.com",
  phone_number = "+358401234567",
  thresholds = { tC: { max: 30, hysteresis: 0.5 } }, // päivitetty: käytä tC
  cooldownSec = 1800,
} = {}) {
  return { userSub, active, channels, email, phone_number, thresholds, cooldownSec };
}

beforeEach(async () => {
  // Aseta envit ENNEN SUT-importtia
  process.env.SUBS_TABLE = "alert_subscriptions";
  process.env.STATE_TABLE = "alert_state";
  process.env.SES_FROM = "noreply@example.com";

  // Nollaa Vitestin moduulivälimuisti ja importoi SUT vasta nyt
  vi.resetModules();
  ({ handler } = await import("../src/lambda_alert_evaluator.mjs"));

  ddbMock.reset();
  snsMock.reset();
  sesMock.reset();

  // Default: subscription exists
  ddbMock.on(QueryCommand).resolves({ Items: [ subsItem() ] });

  // Default: no previous state
  ddbMock.on(GetCommand).resolves({ Item: undefined });

  // Default: accept state write
  ddbMock.on(PutCommand).resolves({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pei-lambda-alert-evaluator", () => {
  it("lähettää hälytyksen (email+sms) kun raja ylittyy ja ei ole cooldownia", async () => {
    const evt = streamEvent({
      sensorId: "elt-123",
      measurements: { tC: 31.2, rhPct: 40 }, // päivitetty metrinimet
    });

    const res = await handler(evt);
    expect(res.ok).toBe(true);

    // Subscription haetaan
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(1);

    // Edellinen tila haetaan
    expect(ddbMock.commandCalls(GetCommand).length).toBeGreaterThanOrEqual(1);

    // Viestit lähtevät
    expect(snsMock.commandCalls(PublishCommand).length).toBe(1);
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(1);

    // Tila kirjoitetaan high
    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThanOrEqual(1);
    const putCall = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putCall.TableName).toBe("alert_state");
    expect(putCall.Item.lastState).toBe("high");
    expect(putCall.Item.pk).toBe("elt-123#tC"); // päivitetty: tC
    expect(putCall.Item.sk).toBe("u1");
  });

  it("ei lähetä uutta hälytystä cooldownin sisällä", async () => {
    const recentIso = new Date(Date.now() - 10 * 1000).toISOString(); // 10s sitten
    ddbMock.on(GetCommand).resolves({ Item: { lastState: "high", lastNotifiedAt: recentIso } });

    const evt = streamEvent({
      sensorId: "elt-123",
      measurements: { tC: 32.0 }, // edelleen yli max
    });

    const res = await handler(evt);
    expect(res.ok).toBe(true);

    // Cooldown estää uudet viestit
    expect(snsMock.commandCalls(PublishCommand).length).toBe(0);
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(0);
    // Ei myöskään kirjoiteta uutta tilaa (jos tila ei muuttunut)
    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
  });

  it("kirjaa palautuksen ok-tilaan ilman viestien lähetystä", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { lastState: "high", lastNotifiedAt: new Date(Date.now()-2000).toISOString() } });
    ddbMock.on(QueryCommand).resolves({
      Items: [ subsItem({ thresholds: { tC: { max: 30, hysteresis: 0.5 } } }) ],
    });

    const evt = streamEvent({
      sensorId: "elt-123",
      measurements: { tC: 28 }, // takaisin OK
    });

    const res = await handler(evt);
    expect(res.ok).toBe(true);

    // EI viestejä paluusta OK-tilaan
    expect(snsMock.commandCalls(PublishCommand).length).toBe(0);
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(0);

    // Tila päivitetään ok:ksi
    expect(ddbMock.commandCalls(PutCommand).length).toBe(1);
    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item.lastState).toBe("ok");
  });

  it("ei tee mitään jos mittarille ei ole thresholdia", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [ subsItem({ thresholds: {} }) ] });

    const evt = streamEvent({
      sensorId: "elt-1",
      measurements: { rhPct: 90 }, // ei thresholdia -> ei käsittelyä
    });

    const res = await handler(evt);
    expect(res.ok).toBe(true);

    expect(snsMock.commandCalls(PublishCommand).length).toBe(0);
    expect(sesMock.commandCalls(SendEmailCommand).length).toBe(0);
    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
  });

  it("skippaa REMOVE-eventit ja tyhjät mittaukset", async () => {
    await handler(removeEvent());
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);

    const evt = streamEvent({ sensorId: "elt-2", measurements: {} });
    await handler(evt);
    expect(ddbMock.commandCalls(QueryCommand).length).toBe(0);
  });
});
