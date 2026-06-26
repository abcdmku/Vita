import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSurfaceHost,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  SurfaceHostRequest,
  SurfaceHostTransport,
} from "../../../../ui_kits/desktop/runtime/host-bridge.ts";
import type {
  DesktopHost,
  RegisteredShellComponent,
  ShellResult,
} from "../../src/desktop-sdk/index.ts";

test("createSurfaceHost accepts a registered shell component returned by the backend", () => {
  const requests: SurfaceHostRequest[] = [];
  const definition = componentDefinition("vita.test.request");
  const backendComponent = registeredComponent("vita.test.backend");
  const host = createSurfaceHost({
    request(request) {
      requests.push(request);

      return {
        ok: true,
        value: backendComponent,
      };
    },
  } satisfies SurfaceHostTransport);

  const result = callRegisterComponent(host, definition);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, backendComponent);
  assert.deepEqual(requests, [
    {
      args: [definition],
      method: "registerComponent",
    },
  ]);
});

const malformedRegisteredComponentCases = Object.freeze([
  Object.freeze({
    name: "missing id",
    value: Object.freeze({
      defaultPlacement: placement(),
      role: "panel",
    }),
  }),
  Object.freeze({
    name: "non-string id",
    value: Object.freeze({
      defaultPlacement: placement(),
      id: 42,
      role: "panel",
    }),
  }),
  Object.freeze({
    name: "missing role",
    value: Object.freeze({
      defaultPlacement: placement(),
      id: "vita.test.panel",
    }),
  }),
  Object.freeze({
    name: "non-string role",
    value: Object.freeze({
      defaultPlacement: placement(),
      id: "vita.test.panel",
      role: false,
    }),
  }),
  Object.freeze({
    name: "non-placement defaultPlacement",
    value: Object.freeze({
      defaultPlacement: Object.freeze({
        layer: "desktop",
        order: "0",
        zone: "root",
      }),
      id: "vita.test.panel",
      role: "panel",
    }),
  }),
  Object.freeze({
    name: "non-object value",
    value: "vita.test.panel",
  }),
]);

for (const testCase of malformedRegisteredComponentCases) {
  test(`createSurfaceHost rejects malformed registered shell component values: ${testCase.name}`, () => {
    const host = createSurfaceHost({
      request() {
        return {
          ok: true,
          value: testCase.value,
        };
      },
    } satisfies SurfaceHostTransport);

    const result = callRegisterComponent(host, componentDefinition(`vita.test.${testCase.name}`));

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("malformed registered shell component unexpectedly succeeded");
    assert.equal(result.error.code, "HOST_BRIDGE_MALFORMED_RESPONSE");
    assert.equal(result.error.path, "/registerComponent/value");
  });
}

function callRegisterComponent(
  host: Pick<DesktopHost, "registerComponent">,
  definition: unknown,
): ShellResult<RegisteredShellComponent> {
  const registerComponent = host.registerComponent as (
    component: unknown,
  ) => ReturnType<DesktopHost["registerComponent"]>;

  return registerComponent(definition);
}

function componentDefinition(id: string): unknown {
  return Object.freeze({
    defaultPlacement: placement(),
    id,
    role: "panel",
  });
}

function registeredComponent(id: string) {
  return Object.freeze({
    defaultPlacement: placement(),
    id,
    role: "panel",
  });
}

function placement() {
  return Object.freeze({
    layer: "desktop",
    order: 7,
    zone: "root",
  });
}
