import { mock } from "bun:test";

mock.module("@getpaseo/plugin/server", () => ({
  defineRpc: <
    Definition extends { name: string; input: unknown; output: unknown },
  >(
    definition: Definition,
  ) => definition,
}));

mock.module("@getpaseo/plugin", () => ({
  usePaseo: () => ({}),
  useRpc: () => () => {},
}));

mock.module("@getpaseo/plugin/react-native", () => ({
  useToast: () => ({
    show: () => {},
    error: () => {},
  }),
}));

mock.module("react-native", () => ({
  Clipboard: { setString: () => {} },
  FlatList: "FlatList",
  Linking: { openURL: async () => true },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
  StyleSheet: { create: (styles: unknown) => styles },
}));
