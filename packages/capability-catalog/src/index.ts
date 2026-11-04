import { AugError, hasRequiredScopes } from "@aug/core";
import type { Capability, ImportedCapability, OperationBinding, Principal } from "@aug/core";

interface CatalogEntry {
  tenantId: string;
  capability: Capability;
  binding: OperationBinding;
}

export class CapabilityCatalog {
  private readonly entries = new Map<string, CatalogEntry>();

  register(tenantId: string, imported: ImportedCapability): void {
    const key = this.key(tenantId, imported.capability.id);
    if (this.entries.has(key)) {
      throw new AugError("DUPLICATE_CAPABILITY", "Capability is already registered", 409);
    }
    this.entries.set(key, { tenantId, ...imported });
  }

  listForPrincipal(principal: Principal): Capability[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.tenantId === principal.tenantId &&
          hasRequiredScopes(principal, entry.capability.requiredScopes),
      )
      .map((entry) => entry.capability);
  }

  getForPrincipal(principal: Principal, capabilityId: string): Capability {
    const entry = this.getEntry(principal, capabilityId);
    return entry.capability;
  }

  getBinding(principal: Principal, capabilityId: string): OperationBinding {
    const entry = this.getEntry(principal, capabilityId);
    return entry.binding;
  }

  private getEntry(principal: Principal, capabilityId: string): CatalogEntry {
    const entry = this.entries.get(this.key(principal.tenantId, capabilityId));
    if (!entry || !hasRequiredScopes(principal, entry.capability.requiredScopes)) {
      throw new AugError("CAPABILITY_NOT_FOUND", "Capability is not available", 404);
    }
    return entry;
  }

  private key(tenantId: string, capabilityId: string): string {
    return `${tenantId}:${capabilityId}`;
  }
}
