export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type Audience = "view" | "model";
export type DeliveryKind = "inline" | "reference";

export interface AugRepresentation {
  id: string;
  /** Versioned profile identifier, independent of a particular domain or UI toolkit. */
  profile: string;
  mediaType: string;
  /** Explicit destinations permitted by the producer; never inferred from the format. */
  audiences: Audience[];
  delivery:
    | { kind: "inline"; value: JsonValue }
    | { kind: "reference"; href: string };
}

export interface AugOutput {
  protocolVersion: string;
  id: string;
  /** Producer preference order. Each entry must describe the same logical result. */
  representations: AugRepresentation[];
}

export interface AugRuntimeCapabilities {
  protocolVersions: string[];
  profiles: string[];
  mediaTypes: string[];
  deliveryKinds: DeliveryKind[];
}

export interface NegotiatedOutput {
  protocolVersion: string;
  outputId: string;
  audience: Audience;
  /** Only the selected representation crosses this delivery boundary. */
  representation: AugRepresentation;
}

export interface CollectionValue {
  columns: { key: string; label?: string }[];
  rows: JsonObject[];
}
