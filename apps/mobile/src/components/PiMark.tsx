import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

/**
 * The π brand mark, matching the desktop sidebar's PiMark SVG
 * (apps/web SidebarChrome.tsx). Square viewBox, so width equals height.
 */
export function PiMark(props: { readonly height: number; readonly color: ColorValue }) {
  return (
    <Svg
      accessibilityLabel="Piπot"
      height={props.height}
      width={props.height}
      viewBox="0 0 100 100"
    >
      <Path
        d="M12 24H88 M34 27V79 M74 27V79"
        fill="none"
        stroke={props.color}
        strokeLinecap="round"
        strokeWidth={18}
      />
    </Svg>
  );
}
