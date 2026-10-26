// Decky UI components, loosely typed on purpose: the props these accept
// (flow-children, closeModal, ...) shift between @decky/ui versions.
import * as DFL from "@decky/ui";

const D = DFL as any;

export const ModalRoot: any = D.ModalRoot;
export const DialogHeader: any = D.DialogHeader;
export const DialogBody: any = D.DialogBody;
export const DialogButton: any = D.DialogButton;
export const DropdownItem: any = D.DropdownItem;
export const Focusable: any = D.Focusable;
export const PanelSection: any = D.PanelSection;
export const PanelSectionRow: any = D.PanelSectionRow;
export const ButtonItem: any = D.ButtonItem;
export const ToggleField: any = D.ToggleField;
export const TextField: any = D.TextField;
export const staticClasses: any = D.staticClasses;
export const showModal: (modal: any, parentWindow?: any) => any = D.showModal;
// Read live (not at load), like the rest of the game-page logic: Steam's router
// state and its CSS-module class names for the game page's button row.
export const getRouter = (): any => D.Router;
export const getPlaySectionClasses = (): any => D.playSectionClasses;
