// /api/config — see server/account.mjs
import { handle } from "../../server/account.mjs";

export const onRequest = ctx => handle("config", ctx);
