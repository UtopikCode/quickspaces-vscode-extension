import { createQuickspacesControlPlaneClient } from '@utopikcode/quickspaces-control-plane-api-client';
import type { ControlPlane, CreateWorkspaceRequest, UpdateWorkspaceRequest, WorkspaceInfo } from './types';
import { trimTrailingSlashes } from './utils';
import {
    type BackingStore,
    type BackingStoreFactory,
    type ErrorMappings,
    type Parsable,
    type ParsableFactory,
    type PrimitiveTypesForDeserialization,
    type PrimitiveTypesForDeserializationType,
    ParseNodeFactoryRegistry,
    SerializationWriterFactoryRegistry,
    type RequestAdapter,
    type RequestInformation,
} from '@microsoft/kiota-abstractions';

class InMemoryBackingStore implements BackingStore {
    private readonly values = new Map<string, unknown>();
    private readonly subscriptions = new Map<string, () => { key: string; previousValue: unknown; newValue: unknown; }>();
    private subscriptionCounter = 0;
    initializationCompleted = false;
    returnOnlyChangedValues = false;

    clear(): void {
        this.values.clear();
    }

    enumerate(): { key: string; value: unknown }[] {
        return [...this.values.entries()].map(([key, value]) => ({ key, value }));
    }

    enumerateKeysForValuesChangedToNull(): string[] {
        return [...this.values.entries()]
            .filter(([, value]) => value === null)
            .map(([key]) => key);
    }

    get<T>(key: string): T | undefined {
        return this.values.get(key) as T | undefined;
    }

    remove(_key: string, _value: unknown): boolean {
        return false;
    }

    set<T>(key: string, value: T): void {
        this.values.set(key, value);
        this.subscriptions.forEach(callback => callback());
    }

    subscribe(callback: () => { key: string; previousValue: unknown; newValue: unknown; }, subscriptionId?: string): string {
        const id = subscriptionId ?? `${Date.now()}-${++this.subscriptionCounter}`;
        this.subscriptions.set(id, callback);
        return id;
    }

    unsubscribe(subscriptionId: string): void {
        this.subscriptions.delete(subscriptionId);
    }
}

class InMemoryBackingStoreFactory implements BackingStoreFactory {
    createBackingStore(): BackingStore {
        return new InMemoryBackingStore();
    }
}

class FetchRequestAdapter implements RequestAdapter {
    public baseUrl: string;
    private readonly parseNodeFactory = new ParseNodeFactoryRegistry();
    private readonly serializationWriterFactory = new SerializationWriterFactoryRegistry();
    private readonly backingStoreFactory = new InMemoryBackingStoreFactory();

    constructor(baseUrl: string, private readonly accessToken?: string) {
        this.baseUrl = baseUrl;
    }

    enableBackingStore(_backingStoreFactory?: BackingStoreFactory | undefined): void {
        // Backing store is supported by the factory.
    }

    getBackingStoreFactory(): BackingStoreFactory {
        return this.backingStoreFactory;
    }

    getParseNodeFactory(): ParseNodeFactoryRegistry {
        return this.parseNodeFactory;
    }

    getSerializationWriterFactory(): SerializationWriterFactoryRegistry {
        return this.serializationWriterFactory;
    }

    async convertToNativeRequest<T>(requestInfo: RequestInformation): Promise<T> {
        const request = new Request(requestInfo.URL, this.buildFetchInit(requestInfo));
        return request as unknown as T;
    }

    async send<ModelType extends Parsable>(requestInfo: RequestInformation, type: ParsableFactory<ModelType>, errorMappings: ErrorMappings | undefined): Promise<ModelType | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) {
            return undefined;
        }

        return this.parseNodeFactory.deserializeFromJson(buffer, type) as ModelType | undefined;
    }

    async sendCollection<ModelType extends Parsable>(requestInfo: RequestInformation, type: ParsableFactory<ModelType>, errorMappings: ErrorMappings | undefined): Promise<ModelType[] | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) {
            return undefined;
        }

        return this.parseNodeFactory.deserializeCollectionFromJson(buffer, type) as ModelType[] | undefined;
    }

    async sendCollectionOfPrimitive<ResponseType extends Exclude<PrimitiveTypesForDeserializationType, ArrayBuffer>>(
        requestInfo: RequestInformation,
        responseType: Exclude<PrimitiveTypesForDeserialization, 'ArrayBuffer'>,
        errorMappings: ErrorMappings | undefined,
    ): Promise<ResponseType[] | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const text = await response.text();
        if (!text) {
            return undefined;
        }

        return JSON.parse(text) as ResponseType[] | undefined;
    }

    async sendEnum<EnumObject extends Record<string, unknown>>(
        requestInfo: RequestInformation,
        type: EnumObject,
        errorMappings: ErrorMappings | undefined,
    ): Promise<EnumObject[keyof EnumObject] | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const text = await response.text();
        if (!text) {
            return undefined;
        }

        return JSON.parse(text) as EnumObject[keyof EnumObject] | undefined;
    }

    async sendCollectionOfEnum<EnumObject extends Record<string, unknown>>(
        requestInfo: RequestInformation,
        type: EnumObject,
        errorMappings: ErrorMappings | undefined,
    ): Promise<EnumObject[keyof EnumObject][] | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const text = await response.text();
        if (!text) {
            return undefined;
        }

        return JSON.parse(text) as EnumObject[keyof EnumObject][] | undefined;
    }

    async sendNoResponseContent(requestInfo: RequestInformation, errorMappings: ErrorMappings | undefined): Promise<void> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }
    }

    async sendPrimitive<ResponseType extends PrimitiveTypesForDeserializationType>(
        requestInfo: RequestInformation,
        responseType: PrimitiveTypesForDeserialization,
        errorMappings: ErrorMappings | undefined,
    ): Promise<ResponseType | undefined> {
        const response = await this.executeRequest(requestInfo);
        if (!response.ok) {
            await this.throwResponseError(response, errorMappings);
        }

        const text = await response.text();
        if (!text) {
            return undefined;
        }

        switch (responseType) {
            case 'string':
                return text as ResponseType;
            case 'number':
                return Number(text) as ResponseType;
            case 'boolean':
                return (text === 'true') as ResponseType;
            case 'Date':
                return new Date(text) as ResponseType;
            default:
                return JSON.parse(text) as ResponseType;
        }
    }

    private buildFetchInit(requestInfo: RequestInformation): RequestInit {
        const headers = new globalThis.Headers();
        if (requestInfo.headers) {
            requestInfo.headers.forEach((values, name) => {
                if (values) {
                    for (const value of values) {
                        headers.append(name, value);
                    }
                }
            });
        }
        if (this.accessToken && !headers.has('Authorization')) {
            headers.set('Authorization', `Bearer ${this.accessToken}`);
        }

        const init: RequestInit = {
            method: requestInfo.httpMethod ?? 'GET',
            headers,
        };

        if (requestInfo.content) {
            init.body = requestInfo.content;
        }

        return init;
    }

    private async executeRequest(requestInfo: RequestInformation): Promise<Response> {
        return await fetch(requestInfo.URL, this.buildFetchInit(requestInfo));
    }

    private async throwResponseError(response: Response, errorMappings: ErrorMappings | undefined): Promise<never> {
        const text = await response.text();
        if (errorMappings) {
            const mapping = this.getErrorMapping(response.status, errorMappings);
            if (mapping) {
                const buffer = new TextEncoder().encode(text).buffer;
                const error = this.parseNodeFactory.deserializeFromJson(buffer, mapping as ParsableFactory<Parsable>);
                throw error instanceof Error ? error : new Error(JSON.stringify(error));
            }
        }

        throw new Error(text || `HTTP ${response.status}`);
    }

    private getErrorMapping(statusCode: number, errorMappings: ErrorMappings): ParsableFactory<Parsable> | undefined {
        if (errorMappings[statusCode]) {
            return errorMappings[statusCode] as ParsableFactory<Parsable>;
        }
        if (statusCode >= 400 && statusCode < 500 && errorMappings._4XX) {
            return errorMappings._4XX as ParsableFactory<Parsable>;
        }
        if (statusCode >= 500 && statusCode < 600 && errorMappings._5XX) {
            return errorMappings._5XX as ParsableFactory<Parsable>;
        }
        if (errorMappings.XXX) {
            return errorMappings.XXX as ParsableFactory<Parsable>;
        }
        return undefined;
    }
}

class ControlPlaneClientAdapter {
    constructor(private readonly client: ReturnType<typeof createQuickspacesControlPlaneClient>, private readonly baseUrl: string) {}

    async probe(): Promise<void> {
        await fetch(this.baseUrl, { method: 'HEAD' });
    }

    async listWorkspaces(): Promise<WorkspaceInfo[]> {
        const workspaces = await this.client.api.v1.workspaces.get();
        return (workspaces ?? []) as WorkspaceInfo[];
    }

    async createWorkspace(requestBody: CreateWorkspaceRequest): Promise<void> {
        await this.client.api.v1.workspaces.post(requestBody);
    }

    async updateWorkspace(workspaceId: string, requestBody: Partial<UpdateWorkspaceRequest>): Promise<void> {
        await this.client.api.v1.workspaces.byId(workspaceId).patch(requestBody as CreateWorkspaceRequest);
    }

    async deleteWorkspace(workspaceId: string): Promise<void> {
        await this.client.api.v1.workspaces.byId(workspaceId).delete();
    }
}

export function createControlPlaneApiClient(controlPlane: ControlPlane, accessToken?: string) {
    const baseUrl = trimTrailingSlashes(controlPlane.url);
    const adapter = new FetchRequestAdapter(baseUrl, accessToken);
    const client = createQuickspacesControlPlaneClient(adapter);
    return new ControlPlaneClientAdapter(client, baseUrl);
}
