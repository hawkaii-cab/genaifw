import type {
    ClientEvent,
    ServerAction,
    ServerMessage,
    Session,
} from "./types";
import { getFeatureFromRegistry } from "./registry";
import { getSession, newSession, saveSession } from "./store";
import { resolve, BASE_TOOLS } from "./agent";
import {
    validateIndianCity,
    checkDriverRating,
    logIntent,
    getAudioUrl,
    getAudioUrlDirect,
} from "./services";

//  Post-Processor System

type PostProcessorFn = (
    actions: ServerAction[],
    session: Session,
    event: ClientEvent,
) => Promise<ServerAction[]>;

const postProcessors = new Map<string, PostProcessorFn>();

/** Register a post-processor by name. */
export function registerPostProcessor(name: string, fn: PostProcessorFn): void {
    postProcessors.set(name, fn);
}

//  Built-in Post-Processors

postProcessors.set("duties", dutiesPostProcessor);
postProcessors.set("fraud", fraudPostProcessor);

//  Event Router

/**
 * Main entry point. Routes a ClientEvent to the appropriate handler
 * and returns a ServerMessage with ordered actions.
 */
export async function handleEvent(event: ClientEvent): Promise<ServerMessage> {
    // Pre-agent shortcuts (no AI needed)
    if (event.type === "init") {
        return handleInit(event);
    }

    //  Agent pipeline
    const session = await resolveSession(event);
    addEventToHistory(session, event);

    const actions = await resolve(session);
    const enriched = await postProcess(session, actions, event);

    // Fire-and-forget analytics
    trackAnalytics(session, event, enriched);

    return {
        sessionId: event.sessionId,
        actions: enriched,
        metadata: {
            feature: session.activeFeature ?? undefined,
            intent: deriveIntent(enriched),
        },
    };
}

//  Pre-Agent Handlers
function handleInit(event: ClientEvent): ServerMessage {
    const data = event.data ?? {};
    const isHome = (data["isHome"] as boolean) ?? true;
    const requestCount = (data["requestCount"] as number) ?? 0;

    // Pick entry audio variant
    let audioKey = "entry";
    if (!isHome && requestCount > 0) {
        audioKey = "entry_request_count";
    } else if (!isHome) {
        audioKey = "entry_2";
    }

    // Verify the key exists, fallback to default
    const url = getAudioUrlDirect(audioKey);
    if (!url) audioKey = "entry";

    return {
        sessionId: event.sessionId,
        actions: [{ type: "playAudio", key: audioKey }],
    };
}

//  Session Resolution
async function resolveSession(event: ClientEvent): Promise<Session> {
    let session = await getSession(event.sessionId);

    if (!session) {
        session = newSession(
            event.sessionId,
            BASE_TOOLS,
            event.context?.userData,
            event.context?.driverProfile,
            event.context?.location,
        );
    } else {
        // Merge any updated context
        if (event.context?.userData) {
            session.userData = {
                ...session.userData,
                ...event.context.userData,
            };
        }
        if (event.context?.driverProfile) {
            session.driverProfile = event.context.driverProfile;
        }
        if (event.context?.location) {
            session.currentLocation = event.context.location;
        }
    }

    await saveSession(session);
    return session;
}

//  History Management

function addEventToHistory(session: Session, event: ClientEvent): void {
    switch (event.type) {
        case "message":
            if (event.text?.trim()) {
                session.history.push({
                    role: "user",
                    parts: [{ text: event.text.trim() }],
                });
            }
            break;
        case "screenChange":
            session.history.push({
                role: "user",
                parts: [
                    {
                        text: `[User navigated to screen: ${event.screen ?? "unknown"}]`,
                    },
                ],
            });
            break;
        case "submit":
            session.history.push({
                role: "user",
                parts: [
                    {
                        text: `[User submitted form on ${event.screen ?? "unknown"}: ${JSON.stringify(event.data ?? {})}]`,
                    },
                ],
            });
            break;
    }
}

//  Post-Processing Pipeline
async function postProcess(
    session: Session,
    actions: ServerAction[],
    event: ClientEvent,
): Promise<ServerAction[]> {
    if (!session.activeFeature) return actions;

    const feature = getFeatureFromRegistry(session.activeFeature);
    if (!feature?.postProcessor) return actions;

    const processor = postProcessors.get(feature.postProcessor);
    if (!processor) return actions;

    try {
        return await processor(actions, session, event);
    } catch (e: unknown) {
        console.error(
            `[PostProcessor:${feature.postProcessor}] Error:`,
            (e as Error).message,
        );
        return actions;
    }
}

//  Duties Post-Processor

async function dutiesPostProcessor(
    actions: ServerAction[],
    session: Session,
    _event: ClientEvent,
): Promise<ServerAction[]> {
    // Find the uiAction with duties data
    const dutiesIdx = actions.findIndex(
        (a) =>
            a.type === "uiAction" &&
            a.data &&
            (a.data["from_city"] || a.data["to_city"]),
    );

    if (dutiesIdx === -1) return actions;

    const dutiesAction = actions[dutiesIdx]! as Extract<
        ServerAction,
        { type: "uiAction" }
    >;
    const fromCity = (dutiesAction.data?.["from_city"] as string) ?? "";
    const toCity = (dutiesAction.data?.["to_city"] as string) ?? "";
    const pickupEmpty = !fromCity.trim();
    const dropEmpty = !toCity.trim();

    // Both cities missing -> entry
    if (pickupEmpty && dropEmpty) {
        return [{ type: "playAudio", key: "entry" }];
    }

    // Validate India

    if (!pickupEmpty) {
        const v = await validateIndianCity(fromCity);
        if (v.country && !v.valid) {
            return [
                { type: "playAudio", key: "india_only" },
                { type: "navigate", screen: "end" },
            ];
        }
        if (v.coordinates) {
            // Coordinates are intentionally ignored for duties payload
        }
    }

    if (!dropEmpty) {
        const v = await validateIndianCity(toCity);
        if (v.country && !v.valid) {
            return [
                { type: "playAudio", key: "india_only" },
                { type: "navigate", screen: "end" },
            ];
        }
    }

    // Pick audio key
    let audioKey = "get_duties";
    if (pickupEmpty !== dropEmpty) {
        audioKey = "duties_no_pickup_drop";
    }

    // Replace the original speak with playAudio, keep other actions, enrich duties data
    const result: ServerAction[] = [];
    let audioAdded = false;

    for (let i = 0; i < actions.length; i++) {
        if (i === dutiesIdx) {
            // Enrich duties action with query info
            result.push({
                type: "uiAction",
                action: dutiesAction.action,
                data: {
                    query: {
                        pickup_city: fromCity,
                        drop_city: toCity,
                    },
                },
            });
        } else if (!audioAdded && actions[i]!.type === "speak") {
            // Replace first speak with predefined audio
            result.push({ type: "playAudio", key: audioKey });
            audioAdded = true;
        } else {
            result.push(actions[i]!);
        }
    }

    // If no speak was found to replace, prepend audio
    if (!audioAdded) {
        result.unshift({ type: "playAudio", key: audioKey });
    }

    return result;
}

//  Fraud Post-Processor

async function fraudPostProcessor(
    actions: ServerAction[],
    session: Session,
    event: ClientEvent,
): Promise<ServerAction[]> {
    const phoneNo =
        session.driverProfile?.phone ?? event.context?.userData?.phoneNo;
    if (!phoneNo) return actions;

    try {
        const fraudResult = await checkDriverRating(phoneNo);
        if (!fraudResult.ratingKey || !fraudResult.data) return actions;

        // Add fraud result data to any fraud uiAction
        const result: ServerAction[] = [];
        let enriched = false;

        for (const a of actions) {
            if (a.type === "uiAction" && !enriched) {
                result.push({
                    type: "uiAction",
                    action: "show_fraud_result",
                    data: fraudResult.data,
                });
                enriched = true;
            } else if (a.type === "speak" && fraudResult.ratingKey) {
                // Replace speak with predefined fraud audio
                result.push({ type: "playAudio", key: fraudResult.ratingKey });
            } else {
                result.push(a);
            }
        }

        return result;
    } catch (e: unknown) {
        console.error("[FraudPostProcessor]", (e as Error).message);
        return actions;
    }
}

//  Analytics
function deriveIntent(actions: ServerAction[]): string {
    for (const a of actions) {
        if (a.type === "uiAction") return a.action;
        if (a.type === "navigate") return a.screen;
        if (a.type === "playAudio") return a.key;
    }
    return "generic";
}

function trackAnalytics(
    session: Session,
    event: ClientEvent,
    actions: ServerAction[],
): void {
    if (!session.driverProfile?.id) return;

    const intent = deriveIntent(actions);
    const text = event.text ?? "";

    // Extract query info from actions
    let pickupCity: string | undefined;
    let dropCity: string | undefined;
    for (const a of actions) {
        if (a.type === "uiAction" && a.data) {
            const q = a.data["query"] as Record<string, unknown> | undefined;
            if (q) {
                pickupCity = q["pickup_city"] as string | undefined;
                dropCity = q["drop_city"] as string | undefined;
            }
        }
    }

    logIntent({
        driverId: session.driverProfile.id,
        queryText: text,
        intent,
        sessionId: session.id,
        interactionCount: 0,
        pickupCity,
        dropCity,
    }).catch(() => {});
}
