import { Agent } from "@earendil-works/pi-agent-core";
import { complete, completeSimple, StringEnum } from "@earendil-works/pi-ai";
import {
	complete as compatComplete,
	completeSimple as compatCompleteSimple,
	StringEnum as compatStringEnum,
} from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { TUI } from "@earendil-works/pi-tui";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Agent as legacyAgent } from "@mariozechner/pi-agent-core";
import { getModel as getLegacyModel } from "@mariozechner/pi-ai";
import { getOAuthProvider as getLegacyOAuthProvider } from "@mariozechner/pi-ai/oauth";
import { TUI as LegacyTUI } from "@mariozechner/pi-tui";
import { createEventBus as createLegacyEventBus } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { Type as SinclairType } from "@sinclair/typebox";
import { Compile as SinclairCompile } from "@sinclair/typebox/compile";
import { Value as SinclairValue } from "@sinclair/typebox/value";

function extension() {}

extension.piAiBindings = {
	root: { complete, completeSimple, StringEnum },
	compat: { complete: compatComplete, completeSimple: compatCompleteSimple, StringEnum: compatStringEnum },
};
extension.compatStringEnumSchema = compatStringEnum(["x"]);

extension.hostBindings = {
	"@earendil-works/pi-agent-core": Agent,
	"@earendil-works/pi-ai/oauth": getOAuthProvider,
	"@earendil-works/pi-tui": TUI,
	"@earendil-works/pi-coding-agent": createEventBus,
	"@mariozechner/pi-agent-core": legacyAgent,
	"@mariozechner/pi-ai": getLegacyModel,
	"@mariozechner/pi-ai/oauth": getLegacyOAuthProvider,
	"@mariozechner/pi-tui": LegacyTUI,
	"@mariozechner/pi-coding-agent": createLegacyEventBus,
	typebox: Type,
	"typebox/compile": Compile,
	"typebox/value": Value,
	"@sinclair/typebox": SinclairType,
	"@sinclair/typebox/compile": SinclairCompile,
	"@sinclair/typebox/value": SinclairValue,
};

export default extension;
