import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Ru"
      height={props.height}
      width={props.height}
      viewBox="-57 3 760 760"
      style={{ overflow: "visible" }}
    >
      <ThemedPath
        d="M455 26Q455 86 434 131Q413 176 371 212Q329 248 266 282Q222 306 196 323Q170 340 158 357Q147 374 147 398Q147 433 167 449Q187 465 236 465H568L604 636H584Q552 636 528 613Q504 590 493 549H412V740H308V549H228Q160 549 119 529Q78 509 60 474Q42 439 42 397Q42 351 60 316Q79 281 116 252Q153 223 206 195Q247 173 274 154Q301 135 316 115Q331 95 338 73Q345 51 345 26Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
