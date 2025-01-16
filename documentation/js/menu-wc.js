'use strict';

customElements.define('compodoc-menu', class extends HTMLElement {
    constructor() {
        super();
        this.isNormalMode = this.getAttribute('mode') === 'normal';
    }

    connectedCallback() {
        this.render(this.isNormalMode);
    }

    render(isNormalMode) {
        let tp = lithtml.html(`
        <nav>
            <ul class="list">
                <li class="title">
                    <a href="index.html" data-type="index-link">labelmed documentation</a>
                </li>

                <li class="divider"></li>
                ${ isNormalMode ? `<div id="book-search-input" role="search"><input type="text" placeholder="Type to search"></div>` : '' }
                <li class="chapter">
                    <a data-type="chapter-link" href="index.html"><span class="icon ion-ios-home"></span>Getting started</a>
                    <ul class="links">
                        <li class="link">
                            <a href="overview.html" data-type="chapter-link">
                                <span class="icon ion-ios-keypad"></span>Overview
                            </a>
                        </li>
                        <li class="link">
                            <a href="index.html" data-type="chapter-link">
                                <span class="icon ion-ios-paper"></span>README
                            </a>
                        </li>
                                <li class="link">
                                    <a href="dependencies.html" data-type="chapter-link">
                                        <span class="icon ion-ios-list"></span>Dependencies
                                    </a>
                                </li>
                                <li class="link">
                                    <a href="properties.html" data-type="chapter-link">
                                        <span class="icon ion-ios-apps"></span>Properties
                                    </a>
                                </li>
                    </ul>
                </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#components-links"' :
                            'data-bs-target="#xs-components-links"' }>
                            <span class="icon ion-md-cog"></span>
                            <span>Components</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="components-links"' : 'id="xs-components-links"' }>
                            <li class="link">
                                <a href="components/AppComponent.html" data-type="entity-link" >AppComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/BlockableDiv.html" data-type="entity-link" >BlockableDiv</a>
                            </li>
                            <li class="link">
                                <a href="components/BlockableP.html" data-type="entity-link" >BlockableP</a>
                            </li>
                            <li class="link">
                                <a href="components/ClassificationConfigurationComponent.html" data-type="entity-link" >ClassificationConfigurationComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/DrawableCanvasComponent.html" data-type="entity-link" >DrawableCanvasComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/EditorComponent.html" data-type="entity-link" >EditorComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/GalleryComponent.html" data-type="entity-link" >GalleryComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/GalleryElementComponent.html" data-type="entity-link" >GalleryElementComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/InstanceLabelComponent.html" data-type="entity-link" >InstanceLabelComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/InteractiveBboxComponent.html" data-type="entity-link" >InteractiveBboxComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/LabelledSwitchComponent.html" data-type="entity-link" >LabelledSwitchComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/LabelsComponent.html" data-type="entity-link" >LabelsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/LoadingComponent.html" data-type="entity-link" >LoadingComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ProjectConfigurationComponent.html" data-type="entity-link" >ProjectConfigurationComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/SVGElementsComponent.html" data-type="entity-link" >SVGElementsComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/TestingComponent.html" data-type="entity-link" >TestingComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ToolbarComponent.html" data-type="entity-link" >ToolbarComponent</a>
                            </li>
                            <li class="link">
                                <a href="components/ToolSettingComponent.html" data-type="entity-link" >ToolSettingComponent</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#classes-links"' :
                            'data-bs-target="#xs-classes-links"' }>
                            <span class="icon ion-ios-paper"></span>
                            <span>Classes</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="classes-links"' : 'id="xs-classes-links"' }>
                            <li class="link">
                                <a href="classes/_RedoStack.html" data-type="entity-link" >_RedoStack</a>
                            </li>
                            <li class="link">
                                <a href="classes/_UndoStack.html" data-type="entity-link" >_UndoStack</a>
                            </li>
                            <li class="link">
                                <a href="classes/MulticlassTask.html" data-type="entity-link" >MulticlassTask</a>
                            </li>
                            <li class="link">
                                <a href="classes/MultilabelTask.html" data-type="entity-link" >MultilabelTask</a>
                            </li>
                            <li class="link">
                                <a href="classes/StampMaker.html" data-type="entity-link" >StampMaker</a>
                            </li>
                            <li class="link">
                                <a href="classes/Tool.html" data-type="entity-link" >Tool</a>
                            </li>
                            <li class="link">
                                <a href="classes/Tools.html" data-type="entity-link" >Tools</a>
                            </li>
                            <li class="link">
                                <a href="classes/UndoRedoStack.html" data-type="entity-link" >UndoRedoStack</a>
                            </li>
                        </ul>
                    </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#injectables-links"' :
                                'data-bs-target="#xs-injectables-links"' }>
                                <span class="icon ion-md-arrow-round-down"></span>
                                <span>Injectables</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="injectables-links"' : 'id="xs-injectables-links"' }>
                                <li class="link">
                                    <a href="injectables/BboxManagerService.html" data-type="entity-link" >BboxManagerService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/CanvasManagerService.html" data-type="entity-link" >CanvasManagerService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/CLIService.html" data-type="entity-link" >CLIService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DrawService.html" data-type="entity-link" >DrawService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/EditorService.html" data-type="entity-link" >EditorService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ImageProcessingService.html" data-type="entity-link" >ImageProcessingService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/IOService.html" data-type="entity-link" >IOService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/LabelsService.html" data-type="entity-link" >LabelsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/OpenCVService.html" data-type="entity-link" >OpenCVService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/PostProcessService.html" data-type="entity-link" >PostProcessService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ProjectService.html" data-type="entity-link" >ProjectService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/StateManagerService.html" data-type="entity-link" >StateManagerService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/SVGUIService.html" data-type="entity-link" >SVGUIService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/UndoRedoService.html" data-type="entity-link" >UndoRedoService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ViewService.html" data-type="entity-link" >ViewService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ZoomPanService.html" data-type="entity-link" >ZoomPanService</a>
                                </li>
                            </ul>
                        </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#interfaces-links"' :
                            'data-bs-target="#xs-interfaces-links"' }>
                            <span class="icon ion-md-information-circle-outline"></span>
                            <span>Interfaces</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? ' id="interfaces-links"' : 'id="xs-interfaces-links"' }>
                            <li class="link">
                                <a href="interfaces/BboxLabel.html" data-type="entity-link" >BboxLabel</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Color.html" data-type="entity-link" >Color</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/EventPayload.html" data-type="entity-link" >EventPayload</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ImageFromCLI.html" data-type="entity-link" >ImageFromCLI</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/LabelFormat.html" data-type="entity-link" >LabelFormat</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/MulticlassInterface.html" data-type="entity-link" >MulticlassInterface</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/MultilabelInterface.html" data-type="entity-link" >MultilabelInterface</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Point2D.html" data-type="entity-link" >Point2D</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Point2D-1.html" data-type="entity-link" >Point2D</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ProjectConfig.html" data-type="entity-link" >ProjectConfig</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ProjectFile.html" data-type="entity-link" >ProjectFile</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Rect.html" data-type="entity-link" >Rect</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Rect-1.html" data-type="entity-link" >Rect</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SegInstance.html" data-type="entity-link" >SegInstance</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SegLabel.html" data-type="entity-link" >SegLabel</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Thumbnail.html" data-type="entity-link" >Thumbnail</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/UndoRedoCanvasElement.html" data-type="entity-link" >UndoRedoCanvasElement</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Viewbox.html" data-type="entity-link" >Viewbox</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Viewbox-1.html" data-type="entity-link" >Viewbox</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#miscellaneous-links"'
                            : 'data-bs-target="#xs-miscellaneous-links"' }>
                            <span class="icon ion-ios-cube"></span>
                            <span>Miscellaneous</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="miscellaneous-links"' : 'id="xs-miscellaneous-links"' }>
                            <li class="link">
                                <a href="miscellaneous/enumerations.html" data-type="entity-link">Enums</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/functions.html" data-type="entity-link">Functions</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/variables.html" data-type="entity-link">Variables</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <a data-type="chapter-link" href="coverage.html"><span class="icon ion-ios-stats"></span>Documentation coverage</a>
                    </li>
                    <li class="divider"></li>
                    <li class="copyright">
                        Documentation generated using <a href="https://compodoc.app/" target="_blank" rel="noopener noreferrer">
                            <img data-src="images/compodoc-vectorise.png" class="img-responsive" data-type="compodoc-logo">
                        </a>
                    </li>
            </ul>
        </nav>
        `);
        this.innerHTML = tp.strings;
    }
});