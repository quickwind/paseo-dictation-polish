import { defineTranslations } from "@getpaseo/plugin/client";
import en from "./locales/en.json";
import zhCn from "./locales/zh-CN.json";

export const polishTranslations = defineTranslations({
  resources: {
    en,
    "zh-CN": zhCn,
  },
});
