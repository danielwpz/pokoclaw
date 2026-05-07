import { dataEntriesToValue, isRecord, setJsonPointer } from "./json.js";
export class SurfaceStore {
  surfaces = new Map();
  applyMessages(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    for (const message of list) {
      this.applyMessage(message);
    }
  }
  updateDataModel(surfaceId, path, value) {
    const surface = this.ensureSurface(surfaceId);
    surface.dataModel = setJsonPointer(surface.dataModel, path, value);
  }
  getSurface(surfaceId) {
    const surface = this.surfaces.get(surfaceId);
    if (surface == null) {
      throw new Error(`Unknown surface: ${surfaceId}`);
    }
    return surface;
  }
  applyMessage(message) {
    if ("surfaceUpdate" in message) {
      this.applySurfaceUpdate(message);
      return;
    }
    if ("dataModelUpdate" in message) {
      this.applyDataModelUpdate(message);
      return;
    }
    if ("beginRendering" in message) {
      this.applyBeginRendering(message);
      return;
    }
    if ("deleteSurface" in message) {
      this.applyDeleteSurface(message);
      return;
    }
  }
  applySurfaceUpdate(message) {
    const surface = this.ensureSurface(message.surfaceUpdate.surfaceId);
    for (const component of message.surfaceUpdate.components) {
      validateComponentNode(component);
      surface.components.set(component.id, component);
    }
  }
  applyDataModelUpdate(message) {
    const update = message.dataModelUpdate;
    const value = dataEntriesToValue(update.contents);
    this.updateDataModel(update.surfaceId, update.path ?? "/", value);
  }
  applyBeginRendering(message) {
    const begin = message.beginRendering;
    const surface = this.ensureSurface(begin.surfaceId);
    surface.root = begin.root;
    if (begin.catalogId === undefined) {
      delete surface.catalogId;
    } else {
      surface.catalogId = begin.catalogId;
    }
    surface.styles = begin.styles ?? {};
  }
  applyDeleteSurface(message) {
    this.surfaces.delete(message.deleteSurface.surfaceId);
  }
  ensureSurface(surfaceId) {
    const existing = this.surfaces.get(surfaceId);
    if (existing != null) {
      return existing;
    }
    const created = {
      surfaceId,
      components: new Map(),
      dataModel: {},
      styles: {},
    };
    this.surfaces.set(surfaceId, created);
    return created;
  }
}
export function readComponentRef(surface, componentId) {
  const node = surface.components.get(componentId);
  if (node == null) {
    throw new Error(`Unknown component '${componentId}' in surface '${surface.surfaceId}'`);
  }
  const entries = Object.entries(node.component);
  if (entries.length !== 1) {
    throw new Error(`Component '${componentId}' must contain exactly one component type`);
  }
  const [type, props] = entries[0];
  if (!isRecord(props)) {
    throw new Error(`Component '${componentId}' properties must be an object`);
  }
  return {
    id: node.id,
    type,
    props: props,
    ...(node.weight === undefined ? {} : { weight: node.weight }),
  };
}
function validateComponentNode(component) {
  if (typeof component.id !== "string" || component.id.length === 0) {
    throw new Error("A2UI component id is required");
  }
  if (!isRecord(component.component)) {
    throw new Error(`A2UI component '${component.id}' must have a component object`);
  }
}
