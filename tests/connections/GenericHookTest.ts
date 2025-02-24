/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { BridgeGenericWebhooksConfig } from "../../src/Config/Config";
import { GenericHookConnection, GenericHookConnectionState } from "../../src/Connections/GenericHook";
import { MessageSenderClient } from "../../src/MatrixSender";
import { createMessageQueue, MessageQueue } from "../../src/MessageQueue";
import { AppserviceMock } from "../utils/AppserviceMock";

const ROOM_ID = "!foo:bar";

const TFFunction = "result = `The answer to '${data.question}' is ${data.answer}`;";

function createGenericHook(state: GenericHookConnectionState = {
    name: "some-name"
}, config: BridgeGenericWebhooksConfig = { enabled: true, urlPrefix: "https://example.com/webhookurl"}): [GenericHookConnection, MessageQueue] {
    const mq = createMessageQueue({
        queue: {
            monolithic: true,
        },
    } as any);
    mq.subscribe('*');
    const messageClient = new MessageSenderClient(mq);
    const connection =  new GenericHookConnection(ROOM_ID, state, "foobar", "foobar", messageClient, config, AppserviceMock.create())
    return [connection, mq];
}

function handleMessage(mq: MessageQueue) {
    return new Promise(r => mq.on('matrix.message', (msg) => {
        mq.push({
            eventName: 'response.matrix.message',
            messageId: msg.messageId,
            sender: 'TestSender',
            data: { 'eventId': '$foo:bar' },
        });
        r(msg.data);
    })); 
}

describe("GenericHookConnection", () => {
    it("will handle a simple hook event", async () => {
        const webhookData = {simple: "data"};
        const [connection, mq] = createGenericHook();
        const messagePromise = handleMessage(mq);
        await connection.onGenericHook(webhookData);
        expect(await messagePromise).to.deep.equal({
            roomId: ROOM_ID,
            sender: connection.getUserId(),
            content: {
                body: "Received webhook data:\n\n```{\n  \"simple\": \"data\"\n}```",
                format: "org.matrix.custom.html",
                formatted_body: "Received webhook data:\n\n<code>{   &quot;simple&quot;: &quot;data&quot; }</code>",
                msgtype: "m.notice",
                "uk.half-shot.hookshot.webhook_data": webhookData,
            },
            type: 'm.room.message',
        });
    });
    it("will handle a hook event containing text", async () => {
        const webhookData = {text: "simple-message"};
        const [connection, mq] = createGenericHook();
        const messagePromise = handleMessage(mq);
        await connection.onGenericHook(webhookData);
        expect(await messagePromise).to.deep.equal({
            roomId: ROOM_ID,
            sender: connection.getUserId(),
            content: {
                body: "simple-message",
                format: "org.matrix.custom.html",
                formatted_body: "simple-message",
                msgtype: "m.notice",
                "uk.half-shot.hookshot.webhook_data": webhookData,
            },
            type: 'm.room.message',
        });
    });
    it("will handle a hook event containing text", async () => {
        const webhookData = {username: "Bobs-integration", type: 42};
        const [connection, mq] = createGenericHook();
        const messagePromise = handleMessage(mq);
        await connection.onGenericHook(webhookData);
        expect(await messagePromise).to.deep.equal({
            roomId: ROOM_ID,
            sender: connection.getUserId(),
            content: {
                body: "**Bobs-integration**: Received webhook data:\n\n```{\n  \"username\": \"Bobs-integration\",\n  \"type\": 42\n}```",
                format: "org.matrix.custom.html",
                formatted_body: "<strong>Bobs-integration</strong>: Received webhook data:\n\n<code>{   &quot;username&quot;: &quot;Bobs-integration&quot;,   &quot;type&quot;: 42 }</code>",
                msgtype: "m.notice",
                "uk.half-shot.hookshot.webhook_data": webhookData,
            },
            type: 'm.room.message',
        });
    });
    it("will handle a hook event with a transformation function", async () => {
        const webhookData = {question: 'What is the meaning of life?', answer: 42};
        const [connection, mq] = createGenericHook({name: 'test', transformationFunction: TFFunction}, {
                enabled: true,
                urlPrefix: "https://example.com/webhookurl",
                allowJsTransformationFunctions: true,
            }
        );
        const messagePromise = handleMessage(mq);
        await connection.onGenericHook(webhookData);
        expect(await messagePromise).to.deep.equal({
            roomId: ROOM_ID,
            sender: connection.getUserId(),
            content: {
                body: "Received webhook: The answer to 'What is the meaning of life?' is 42",
                format: "org.matrix.custom.html",
                formatted_body: "Received webhook: The answer to 'What is the meaning of life?' is 42",
                msgtype: "m.notice",
                "uk.half-shot.hookshot.webhook_data": webhookData,
            },
            type: 'm.room.message',
        });
    });
    it("will fail to handle a webhook with an invalid script", async () => {
        const webhookData = {question: 'What is the meaning of life?', answer: 42};
        const [connection, mq] = createGenericHook({name: 'test', transformationFunction: "bibble bobble"}, {
                enabled: true,
                urlPrefix: "https://example.com/webhookurl",
                allowJsTransformationFunctions: true,
            }
        );
        const messagePromise = handleMessage(mq);
        await connection.onGenericHook(webhookData);
        expect(await messagePromise).to.deep.equal({
            roomId: ROOM_ID,
            sender: connection.getUserId(),
            content: {
                body: "Webhook received but failed to process via transformation function",
                format: "org.matrix.custom.html",
                formatted_body: "Webhook received but failed to process via transformation function",
                msgtype: "m.notice",
                "uk.half-shot.hookshot.webhook_data": webhookData,
            },
            type: 'm.room.message',
        });
    });
})
