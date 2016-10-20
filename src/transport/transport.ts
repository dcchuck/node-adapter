import WebSocketTransport from "./websocket"
import writeToken from "./write-token"
import { Identity } from "../identity"
import EventStore from "./event-store"
import {
    UnexpectedAction,
    NoSuccess,
    DuplicateCorrelation,
    NoAck,
    NoCorrelation
} from "./transport-errors"

class Transport extends WebSocketTransport {
    protected messageCounter = 0
    protected listeners: {resolve: Function, reject: Function}[] = []
    protected eventListeners = new EventStore 
    protected uncorrelatedListener: Function
    protected _identity: Identity
    authenticate(identity: Identity): Promise<string> {
        const { uuid } = this._identity = identity
        let token
        return this.sendAction("request-external-authorization", {
            uuid,
            type: "file-token", // Other type for browser? Ask @xavier
            //authorizationToken: null // Needed?
        }, true)
            .then(({ action, payload }) => {
                if (action !== "external-authorization-response")
                    return Promise.reject(new UnexpectedAction(action))
                else {
                    token = payload.token
                    return writeToken(payload.file, payload.token)
                }
            })
            .then(() => this.sendAction("request-authorization", { uuid, type: "file-token" }, true))
            .then(({ action, payload }) => {
                if (action !== "authorization-response")
                    return Promise.reject(new UnexpectedAction(action))
                else if (payload.success !== true)
                    return Promise.reject(new NoSuccess)
                else 
                    return token
            })
    }
    sendAction(action: string, payload = {}, uncorrelated = false): Promise<Message<any>> {
        return new Promise((resolve, reject) => {
            const id = this.messageCounter++
            this.send({
                action,
                payload,
                messageId: id
            })
            this.addListener(id, resolve, reject, uncorrelated)
        })
    }
    subscribeToEvent(identity: Identity, topic: string, type: string, listener: Function): Promise<void> {
        this.eventListeners.add(identity, topic, type, listener)
        return this.sendAction("subscribe-to-desktop-event", {
            topic,
            type,
            // Spread ...identity
            uuid: identity.uuid, 
            name: identity.name
        })
    }
    get identity(): Identity {
        return this._identity
    }

    protected addListener(id: number, resolve: Function, reject: Function, uncorrelated: boolean): void {
        if (uncorrelated)  
            this.uncorrelatedListener = resolve
        else if (id in this.listeners)
            reject(new DuplicateCorrelation(String(id)))
        else 
            this.listeners[id] = { resolve, reject }
            // Timeout and reject()?
    }
    protected onmessage(data): void {
        const id: number = data.correlationId
        if (data.action === "process-desktop-event") {
            const { topic, type, uuid, name } = data.payload
            for (let f of this.eventListeners.getAll(new Identity(uuid, name), topic, type))
                f.call(null, data.payload)
        } else if (!("correlationId" in data)) {
            this.uncorrelatedListener.call(null, data)
            this.uncorrelatedListener = () => {}
        } else if (!(id in this.listeners))            
            throw new NoCorrelation(String(id))
        else {
            const { resolve, reject } = this.listeners[id]
            if (data.action !== "ack")
                reject(new NoAck(data.action))
            else if (!("payload" in data) || !data.payload.success)
                reject(new NoSuccess)
            else
                resolve.call(null, data)
            delete this.listeners[id]
        }
    }
}
export default Transport
interface Transport {
    sendAction(action: "request-external-authorization", payload: {}, uncorrelated: true): Promise<Message<AuthorizationPayload>>
    sendAction(action: string, payload: {}, uncorrelated: boolean): Promise<Message<Payload>>
}

export class Message<T> {
    action: string
    payload: T
}
export class Payload {
    success: boolean
    data: any
}
export class AuthorizationPayload {
    token: string
    file: string
}