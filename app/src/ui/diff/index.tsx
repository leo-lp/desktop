import { clipboard } from 'electron'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as Path from 'path'
import { Disposable } from 'event-kit'

import { assertNever } from '../../lib/fatal-error'
import {
  NewImageDiff,
  ModifiedImageDiff,
  DeletedImageDiff,
} from './image-diffs'
import { BinaryFile } from './binary-file'

import { Editor } from 'codemirror'
import { CodeMirrorHost } from './code-mirror-host'
import { Repository } from '../../models/repository'
import { encodePathAsUrl } from '../../lib/path'
import { ImageDiffType } from '../../lib/app-state'
import {
  CommittedFileChange,
  WorkingDirectoryFileChange,
  AppFileStatus,
} from '../../models/status'
import {
  DiffSelection,
  DiffType,
  IDiff,
  IImageDiff,
  ITextDiff,
  DiffLine,
  DiffLineType,
  ILargeTextDiff,
} from '../../models/diff'
import { Dispatcher } from '../../lib/dispatcher/dispatcher'

import {
  diffLineForIndex,
  diffHunkForIndex,
  findInteractiveDiffRange,
  lineNumberForDiffLine,
} from './diff-explorer'
import { DiffLineGutter } from './diff-line-gutter'
import { IEditorConfigurationExtra } from './editor-configuration-extra'
import { ISelectionStrategy } from './selection/selection-strategy'
import { DragDropSelection } from './selection/drag-drop-selection-strategy'
import { RangeSelection } from './selection/range-selection-strategy'
import { Octicon, OcticonSymbol } from '../octicons'

import { fatalError } from '../../lib/fatal-error'

import { RangeSelectionSizePixels } from './edge-detection'
import { relativeChanges } from './changed-range'
import { getPartialBlobContents } from '../../lib/git/show'
import { readPartialFile } from '../../lib/file-system'

import { DiffSyntaxMode, IDiffSyntaxModeSpec } from './diff-syntax-mode'
import { highlight } from '../../lib/highlighter/worker'
import { ITokens } from '../../lib/highlighter/types'
import { Button } from '../lib/button'

/** The longest line for which we'd try to calculate a line diff. */
const MaxIntraLineDiffStringLength = 4096

/** The maximum number of bytes we'll process for highlighting. */
const MaxHighlightContentLength = 256 * 1024

// This is a custom version of the no-newline octicon that's exactly as
// tall as it needs to be (8px) which helps with aligning it on the line.
const narrowNoNewlineSymbol = new OcticonSymbol(
  16,
  8,
  'm 16,1 0,3 c 0,0.55 -0.45,1 -1,1 l -3,0 0,2 -3,-3 3,-3 0,2 2,0 0,-2 2,0 z M 8,4 C 8,6.2 6.2,8 4,8 1.8,8 0,6.2 0,4 0,1.8 1.8,0 4,0 6.2,0 8,1.8 8,4 Z M 1.5,5.66 5.66,1.5 C 5.18,1.19 4.61,1 4,1 2.34,1 1,2.34 1,4 1,4.61 1.19,5.17 1.5,5.66 Z M 7,4 C 7,3.39 6.81,2.83 6.5,2.34 L 2.34,6.5 C 2.82,6.81 3.39,7 4,7 5.66,7 7,5.66 7,4 Z'
)

// image used when no diff is displayed
const NoDiffImage = encodePathAsUrl(__dirname, 'static/ufo-alert.svg')

type ChangedFile = WorkingDirectoryFileChange | CommittedFileChange

interface ILineFilters {
  readonly oldLineFilter: Array<number>
  readonly newLineFilter: Array<number>
}

interface IFileContents {
  readonly file: ChangedFile
  readonly oldContents: Buffer
  readonly newContents: Buffer
}

interface IFileTokens {
  readonly oldTokens: ITokens
  readonly newTokens: ITokens
}

async function getOldFileContent(
  repository: Repository,
  file: ChangedFile
): Promise<Buffer> {
  if (file.status === AppFileStatus.New) {
    return new Buffer(0)
  }

  let commitish

  if (file instanceof WorkingDirectoryFileChange) {
    // If we pass an empty string here we get the contents
    // that are in the index. But since we call diff with
    // --no-index (see diff.ts) we need to look at what's
    // actually committed to get the appropriate content.
    commitish = 'HEAD'
  } else if (file instanceof CommittedFileChange) {
    commitish = `${file.commitish}^`
  } else {
    return assertNever(file, 'Unknown file change type')
  }

  return getPartialBlobContents(
    repository,
    commitish,
    file.oldPath || file.path,
    MaxHighlightContentLength
  )
}

async function getNewFileContent(
  repository: Repository,
  file: ChangedFile
): Promise<Buffer> {
  if (file.status === AppFileStatus.Deleted) {
    return new Buffer(0)
  }

  if (file instanceof WorkingDirectoryFileChange) {
    return readPartialFile(
      Path.join(repository.path, file.path),
      0,
      MaxHighlightContentLength - 1
    )
  } else if (file instanceof CommittedFileChange) {
    return getPartialBlobContents(
      repository,
      file.commitish,
      file.path,
      MaxHighlightContentLength
    )
  }

  return assertNever(file, 'Unknown file change type')
}

async function getFileContents(
  repo: Repository,
  file: ChangedFile,
  lineFilters: ILineFilters
): Promise<IFileContents> {
  const oldContentsPromise = lineFilters.oldLineFilter.length
    ? getOldFileContent(repo, file)
    : Promise.resolve(new Buffer(0))

  const newContentsPromise = lineFilters.newLineFilter.length
    ? getNewFileContent(repo, file)
    : Promise.resolve(new Buffer(0))

  const [oldContents, newContents] = await Promise.all([
    oldContentsPromise.catch(e => {
      log.error('Could not load old contents for syntax highlighting', e)
      return new Buffer(0)
    }),
    newContentsPromise.catch(e => {
      log.error('Could not load new contents for syntax highlighting', e)
      return new Buffer(0)
    }),
  ])

  return { file, oldContents, newContents }
}

/**
 * Figure out which lines we need to have tokenized in
 * both the old and new version of the file.
 */
function getLineFilters(diff: ITextDiff): ILineFilters {
  const oldLineFilter = new Array<number>()
  const newLineFilter = new Array<number>()

  const diffLines = new Array<DiffLine>()

  let anyAdded = false
  let anyDeleted = false

  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      anyAdded = anyAdded || line.type === DiffLineType.Add
      anyDeleted = anyDeleted || line.type === DiffLineType.Delete
      diffLines.push(line)
    }
  }

  for (const line of diffLines) {
    // So this might need a little explaining. What we're trying
    // to achieve here is if the diff contains only additions or
    // only deletions we'll source all the highlighted lines from
    // either the before or after file. That way we can completely
    // disregard loading, and highlighting, the other version.
    if (line.oldLineNumber !== null && line.newLineNumber !== null) {
      if (anyAdded && !anyDeleted) {
        newLineFilter.push(line.newLineNumber - 1)
      } else {
        oldLineFilter.push(line.oldLineNumber - 1)
      }
    } else {
      // If there's a mix (meaning we'll have to read from both
      // anyway) we'll prioritize the old version since
      // that's immutable and less likely to be the subject of a
      // race condition when someone rapidly modifies the file on
      // disk.
      if (line.oldLineNumber !== null) {
        oldLineFilter.push(line.oldLineNumber - 1)
      } else if (line.newLineNumber !== null) {
        newLineFilter.push(line.newLineNumber - 1)
      }
    }
  }

  return { oldLineFilter, newLineFilter }
}

async function highlightContents(
  contents: IFileContents,
  tabSize: number,
  lineFilters: ILineFilters
): Promise<IFileTokens> {
  const { file, oldContents, newContents } = contents

  const [oldTokens, newTokens] = await Promise.all([
    highlight(
      oldContents.toString('utf8'),
      Path.extname(file.oldPath || file.path),
      tabSize,
      lineFilters.oldLineFilter
    ).catch(e => {
      log.error('Highlighter worked failed for old contents', e)
      return {}
    }),
    highlight(
      newContents.toString('utf8'),
      Path.extname(file.path),
      tabSize,
      lineFilters.newLineFilter
    ).catch(e => {
      log.error('Highlighter worked failed for new contents', e)
      return {}
    }),
  ])

  return { oldTokens, newTokens }
}

/**
 * Checks to see if any key parameters in the props object that are used
 * when performing highlighting has changed. This is used to determine
 * whether highlighting should abort in between asynchronous operations
 * due to some factor (like which file is currently selected) have changed
 * and thus rendering the in-flight highlighting data useless.
 */
function highlightParametersEqual(newProps: IDiffProps, prevProps: IDiffProps) {
  if (newProps === prevProps) {
    return true
  }

  return (
    newProps.file.path === prevProps.file.path &&
    newProps.file.oldPath === prevProps.file.oldPath &&
    newProps.diff.kind === DiffType.Text &&
    prevProps.diff.kind === DiffType.Text &&
    newProps.diff.text === prevProps.diff.text
  )
}

/** The props for the Diff component. */
interface IDiffProps {
  readonly repository: Repository

  /**
   * Whether the diff is readonly, e.g., displaying a historical diff, or the
   * diff's lines can be selected, e.g., displaying a change in the working
   * directory.
   */
  readonly readOnly: boolean

  /** The file whose diff should be displayed. */
  readonly file: ChangedFile

  /** Called when the includedness of lines or a range of lines has changed. */
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void

  /** The diff that should be rendered */
  readonly diff: IDiff

  /** propagate errors up to the main application */
  readonly dispatcher: Dispatcher

  /** The type of image diff to display. */
  readonly imageDiffType: ImageDiffType
}

interface IDiffState {
  readonly forceShowLargeDiff: boolean
}

/** A component which renders a diff for a file. */
export class Diff extends React.Component<IDiffProps, IDiffState> {
  private codeMirror: Editor | null = null
  private gutterWidth: number | null = null

  /**
   * We store the scroll position before reloading the same diff so that we can
   * restore it when we're done. If we're not reloading the same diff, this'll
   * be null.
   */
  private scrollPositionToRestore: { left: number; top: number } | null = null

  /**
   * A mapping from CodeMirror line handles to disposables which, when disposed
   * cleans up any line gutter components and events associated with that line.
   * See renderLine for more information.
   */
  private readonly lineCleanup = new Map<any, Disposable>()

  /**
   * Maintain the current state of the user interacting with the diff gutter
   */
  private selection: ISelectionStrategy | null = null

  /**
   *  a local cache of gutter elements, keyed by the row in the diff
   */
  private cachedGutterElements = new Map<number, DiffLineGutter>()

  public constructor(props: IDiffProps) {
    super(props)

    this.state = {
      forceShowLargeDiff: false,
    }
  }

  public componentWillReceiveProps(nextProps: IDiffProps) {
    // If we're reloading the same file, we want to save the current scroll
    // position and restore it after the diff's been updated.
    const sameFile =
      nextProps.file &&
      this.props.file &&
      nextProps.file.id === this.props.file.id

    // Happy path, if the text hasn't changed we won't re-render
    // and subsequently won't have to restore the scroll position.
    const textHasChanged = nextProps.diff !== this.props.diff

    const codeMirror = this.codeMirror
    if (codeMirror && sameFile && textHasChanged) {
      const scrollInfo = codeMirror.getScrollInfo()
      this.scrollPositionToRestore = {
        left: scrollInfo.left,
        top: scrollInfo.top,
      }
    } else {
      this.scrollPositionToRestore = null
    }

    if (
      codeMirror &&
      nextProps.diff.kind === DiffType.Text &&
      (this.props.diff.kind !== DiffType.Text ||
        this.props.diff.text !== nextProps.diff.text)
    ) {
      codeMirror.setOption('mode', { name: DiffSyntaxMode.ModeName })
    }

    // HACK: This entire section is a hack. Whenever we receive
    // props we update all currently visible gutter elements with
    // the selection state from the file.
    if (nextProps.file instanceof WorkingDirectoryFileChange) {
      const selection = nextProps.file.selection
      const oldSelection =
        this.props.file instanceof WorkingDirectoryFileChange
          ? this.props.file.selection
          : null

      // Nothing has changed
      if (oldSelection === selection) {
        return
      }

      this.gutterWidth = null

      const diff = nextProps.diff
      this.cachedGutterElements.forEach((element, index) => {
        if (!element) {
          console.error('expected DOM element for diff gutter not found')
          return
        }

        if (diff.kind === DiffType.Text) {
          const line = diffLineForIndex(diff, index)
          const isIncludable = line ? line.isIncludeableLine() : false
          const isSelected = selection.isSelected(index) && isIncludable
          element.setSelected(isSelected)
        }
      })
    }
  }

  public componentWillUnmount() {
    this.dispose()
  }

  public componentDidUpdate(prevProps: IDiffProps) {
    const diff = this.props.diff
    if (diff === prevProps.diff) {
      return
    }

    if (
      prevProps.diff.kind === DiffType.Text &&
      diff.kind === DiffType.Text &&
      diff.text === prevProps.diff.text
    ) {
      return
    }

    if (diff.kind === DiffType.Text && this.codeMirror) {
      this.codeMirror.setOption('mode', { name: DiffSyntaxMode.ModeName })
    }

    this.initDiffSyntaxMode()
  }

  public componentDidMount() {
    if (this.props.diff.kind === DiffType.Text) {
      this.initDiffSyntaxMode()
    }
  }

  public render() {
    return this.renderDiff(this.props.diff)
  }

  public async initDiffSyntaxMode() {
    const cm = this.codeMirror
    const file = this.props.file
    const diff = this.props.diff
    const repo = this.props.repository

    if (!cm || diff.kind !== DiffType.Text) {
      return
    }

    // Store the current props to that we can see if anything
    // changes from underneath us as we're making asynchronous
    // operations that makes our data stale or useless.
    const propsSnapshot = this.props

    const lineFilters = getLineFilters(diff)
    const contents = await getFileContents(repo, file, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    const tsOpt = cm.getOption('tabSize')
    const tabSize = typeof tsOpt === 'number' ? tsOpt : 4

    const tokens = await highlightContents(contents, tabSize, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    const spec: IDiffSyntaxModeSpec = {
      name: DiffSyntaxMode.ModeName,
      diff,
      oldTokens: tokens.oldTokens,
      newTokens: tokens.newTokens,
    }

    cm.setOption('mode', spec)
  }

  private dispose() {
    this.codeMirror = null

    this.lineCleanup.forEach(disposable => disposable.dispose())
    this.lineCleanup.clear()

    document.removeEventListener('mouseup', this.onDocumentMouseUp)
  }

  /**
   * compute the diff gutter width based on what's been rendered in the browser
   */
  private getAndCacheGutterWidth = (): number | null => {
    if (this.gutterWidth) {
      return this.gutterWidth
    }

    if (this.codeMirror) {
      // as getWidth will return 0 for elements that are offscreen, this code
      // will look for the first row of the current viewport, which should be
      // onscreen
      const viewport = this.codeMirror.getScrollInfo()
      const top = viewport.top

      const row = this.codeMirror.lineAtHeight(top, 'local')
      const element = this.cachedGutterElements.get(row)

      if (!element) {
        console.error(
          `unable to find element at ${row}, should probably look into that`
        )
        return null
      }

      this.gutterWidth = element.getWidth()

      if (this.gutterWidth === 0) {
        console.error(
          `element at row ${row} does not have a width, should probably look into that`
        )
      }
    }

    return this.gutterWidth
  }

  private updateRangeHoverState = (
    start: number,
    end: number,
    show: boolean
  ) => {
    for (let i = start; i <= end; i++) {
      this.hoverLine(i, show)
    }
  }

  private hoverLine = (row: number, include: boolean) => {
    const element = this.cachedGutterElements.get(row)

    // element may not be drawn by the editor, so updating it isn't necessary
    if (element) {
      element.setHover(include)
    }
  }

  /**
   * start a selection gesture based on the current interation
   */
  private startSelection = (
    file: WorkingDirectoryFileChange,
    diff: ITextDiff,
    index: number,
    isRangeSelection: boolean
  ) => {
    const snapshot = file.selection
    const selected = snapshot.isSelected(index)
    const desiredSelection = !selected

    if (isRangeSelection) {
      const range = findInteractiveDiffRange(diff, index)
      if (!range) {
        console.error('unable to find range for given line in diff')
        return
      }

      this.selection = new RangeSelection(
        range.start,
        range.end,
        desiredSelection,
        snapshot
      )
    } else {
      this.selection = new DragDropSelection(index, desiredSelection, snapshot)
    }

    this.selection.paint(this.cachedGutterElements)
    document.addEventListener('mouseup', this.onDocumentMouseUp)
  }

  /**
   * Helper event listener, registered when starting a selection by
   * clicking anywhere on or near the gutter. Immediately removes itself
   * from the mouseup event on the document element and ends any current
   * selection.
   *
   * TODO: Once Electron upgrades to Chrome 55 we can drop this in favor
   * of the 'once' option in addEventListener, see
   * https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener
   */
  private onDocumentMouseUp = (ev: MouseEvent) => {
    ev.preventDefault()
    document.removeEventListener('mouseup', this.onDocumentMouseUp)
    this.endSelection()
  }

  /**
   * complete the selection gesture and apply the change to the diff
   */
  private endSelection = () => {
    if (!this.props.onIncludeChanged || !this.selection) {
      return
    }

    this.props.onIncludeChanged(this.selection.done())

    // operation is completed, clean this up
    this.selection = null
  }

  private onGutterMouseDown = (
    index: number,
    diff: ITextDiff,
    isRangeSelection: boolean
  ) => {
    if (!(this.props.file instanceof WorkingDirectoryFileChange)) {
      fatalError(
        'must not start selection when selected file is not a WorkingDirectoryFileChange'
      )
      return
    }

    if (isRangeSelection) {
      const hunk = diffHunkForIndex(diff, index)
      if (!hunk) {
        console.error('unable to find hunk for given line in diff')
      }
    }
    this.startSelection(this.props.file, diff, index, isRangeSelection)
  }

  private onGutterMouseMove = (index: number) => {
    if (!this.selection) {
      return
    }

    this.selection.update(index)
    this.selection.paint(this.cachedGutterElements)
  }

  private onDiffTextMouseMove = (
    ev: MouseEvent,
    diff: ITextDiff,
    index: number
  ) => {
    const isActive = this.isMouseCursorNearGutter(ev)
    if (isActive === null) {
      return
    }

    const diffLine = diffLineForIndex(diff, index)
    if (!diffLine) {
      return
    }

    if (!diffLine.isIncludeableLine()) {
      return
    }

    const range = findInteractiveDiffRange(diff, index)
    if (!range) {
      console.error('unable to find range for given index in diff')
      return
    }

    this.updateRangeHoverState(range.start, range.end, isActive)
  }

  private onDiffTextMouseDown = (
    ev: MouseEvent,
    diff: ITextDiff,
    index: number
  ) => {
    const isActive = this.isMouseCursorNearGutter(ev)

    if (isActive) {
      // this line is important because it prevents the codemirror editor
      // from handling the event and resetting the scroll position.
      // it doesn't do this when you click on elements in the gutter,
      // which is an amazing joke to have placed upon me right now
      ev.preventDefault()

      if (!(this.props.file instanceof WorkingDirectoryFileChange)) {
        fatalError(
          'must not start selection when selected file is not a WorkingDirectoryFileChange'
        )
        return
      }

      this.startSelection(this.props.file, diff, index, true)
    }
  }

  private onDiffTextMouseLeave = (
    ev: MouseEvent,
    diff: ITextDiff,
    index: number
  ) => {
    const range = findInteractiveDiffRange(diff, index)
    if (!range) {
      console.error('unable to find range for given index in diff')
      return
    }

    this.updateRangeHoverState(range.start, range.end, false)
  }

  private isMouseCursorNearGutter = (ev: MouseEvent): boolean | null => {
    const width = this.getAndCacheGutterWidth()

    if (!width) {
      // should fail earlier than this with a helpful error message
      return null
    }

    const deltaX = ev.layerX - width
    return deltaX >= 0 && deltaX <= RangeSelectionSizePixels
  }

  private renderLine = (instance: any, line: any, element: HTMLElement) => {
    const existingLineDisposable = this.lineCleanup.get(line)

    // If we can find the line in our cleanup list that means the line is
    // being re-rendered. Agains, CodeMirror doesn't fire the 'delete' event
    // when this happens.
    if (existingLineDisposable) {
      existingLineDisposable.dispose()
      this.lineCleanup.delete(line)
    }

    const diff = this.props.diff
    if (diff.kind !== DiffType.Text) {
      return
    }

    const index = instance.getLineNumber(line) as number

    const diffLine = diffLineForIndex(diff, index)
    if (diffLine) {
      const diffLineElement = element.children[0] as HTMLSpanElement

      let noNewlineReactContainer: HTMLSpanElement | null = null

      if (diffLine.noTrailingNewLine) {
        noNewlineReactContainer = document.createElement('span')
        noNewlineReactContainer.setAttribute(
          'title',
          'No newline at end of file'
        )
        ReactDOM.render(
          <Octicon symbol={narrowNoNewlineSymbol} className="no-newline" />,
          noNewlineReactContainer
        )
        diffLineElement.appendChild(noNewlineReactContainer)
      }

      const gutterReactContainer = document.createElement('span')

      let isIncluded = false
      if (this.props.file instanceof WorkingDirectoryFileChange) {
        isIncluded = this.props.file.selection.isSelected(index)
      }

      const cache = this.cachedGutterElements

      ReactDOM.render(
        <DiffLineGutter
          line={diffLine}
          isIncluded={isIncluded}
          index={index}
          readOnly={this.props.readOnly}
          diff={diff}
          updateRangeHoverState={this.updateRangeHoverState}
          isSelectionEnabled={this.isSelectionEnabled}
          onMouseDown={this.onGutterMouseDown}
          onMouseMove={this.onGutterMouseMove}
        />,
        gutterReactContainer,
        function(this: DiffLineGutter) {
          if (this !== undefined) {
            cache.set(index, this)
          }
        }
      )

      const onMouseMoveLine: (ev: MouseEvent) => void = ev => {
        this.onDiffTextMouseMove(ev, diff, index)
      }

      const onMouseDownLine: (ev: MouseEvent) => void = ev => {
        this.onDiffTextMouseDown(ev, diff, index)
      }

      const onMouseLeaveLine: (ev: MouseEvent) => void = ev => {
        this.onDiffTextMouseLeave(ev, diff, index)
      }

      if (!this.props.readOnly) {
        diffLineElement.addEventListener('mousemove', onMouseMoveLine)
        diffLineElement.addEventListener('mousedown', onMouseDownLine)
        diffLineElement.addEventListener('mouseleave', onMouseLeaveLine)
      }

      element.insertBefore(gutterReactContainer, diffLineElement)

      // Hack(ish?). In order to be a real good citizen we need to unsubscribe from
      // the line delete event once we've been called once or the component has been
      // unmounted. In the latter case it's _probably_ not strictly necessary since
      // the only thing gc rooted by the event should be isolated and eligble for
      // collection. But let's be extra cautious I guess.
      //
      // The only way to unsubscribe is to pass the exact same function given to the
      // 'on' function to the 'off' so we need a reference to ourselves, basically.
      let deleteHandler: () => void // eslint-disable-line prefer-const

      // Since we manually render a react component we have to take care of unmounting
      // it or else we'll leak memory. This disposable will unmount the component.
      //
      // See https://facebook.github.io/react/blog/2015/10/01/react-render-and-top-level-api.html
      const gutterCleanup = new Disposable(() => {
        this.cachedGutterElements.delete(index)

        ReactDOM.unmountComponentAtNode(gutterReactContainer)

        if (noNewlineReactContainer) {
          ReactDOM.unmountComponentAtNode(noNewlineReactContainer)
        }

        if (!this.props.readOnly) {
          diffLineElement.removeEventListener('mousemove', onMouseMoveLine)
          diffLineElement.removeEventListener('mousedown', onMouseDownLine)
          diffLineElement.removeEventListener('mouseleave', onMouseLeaveLine)
        }

        line.off('delete', deleteHandler)
      })

      // Add the cleanup disposable to our list of disposables so that we clean up when
      // this component is unmounted or when the line is re-rendered. When either of that
      // happens the line 'delete' event doesn't  fire.
      this.lineCleanup.set(line, gutterCleanup)

      // If the line delete event fires we dispose of the disposable (disposing is
      // idempotent)
      deleteHandler = () => {
        const disp = this.lineCleanup.get(line)
        if (disp) {
          this.lineCleanup.delete(line)
          disp.dispose()
        }
      }
      line.on('delete', deleteHandler)
    }
  }

  private isSelectionEnabled = () => {
    return this.selection == null
  }

  private restoreScrollPosition(cm: Editor) {
    const scrollPosition = this.scrollPositionToRestore
    if (cm && scrollPosition) {
      cm.scrollTo(scrollPosition.left, scrollPosition.top)
    }
  }

  private markIntraLineChanges(codeMirror: Editor, diff: ITextDiff) {
    for (const hunk of diff.hunks) {
      const additions = hunk.lines.filter(l => l.type === DiffLineType.Add)
      const deletions = hunk.lines.filter(l => l.type === DiffLineType.Delete)
      if (additions.length !== deletions.length) {
        continue
      }

      for (let i = 0; i < additions.length; i++) {
        const addLine = additions[i]
        const deleteLine = deletions[i]
        if (
          addLine.text.length > MaxIntraLineDiffStringLength ||
          deleteLine.text.length > MaxIntraLineDiffStringLength
        ) {
          continue
        }

        const changeRanges = relativeChanges(
          addLine.content,
          deleteLine.content
        )
        const addRange = changeRanges.stringARange
        if (addRange.length > 0) {
          const addLineNumber = lineNumberForDiffLine(addLine, diff)
          if (addLineNumber > -1) {
            const addFrom = {
              line: addLineNumber,
              ch: addRange.location + 1,
            }
            const addTo = {
              line: addLineNumber,
              ch: addRange.location + addRange.length + 1,
            }
            codeMirror
              .getDoc()
              .markText(addFrom, addTo, { className: 'cm-diff-add-inner' })
          }
        }

        const deleteRange = changeRanges.stringBRange
        if (deleteRange.length > 0) {
          const deleteLineNumber = lineNumberForDiffLine(deleteLine, diff)
          if (deleteLineNumber > -1) {
            const deleteFrom = {
              line: deleteLineNumber,
              ch: deleteRange.location + 1,
            }
            const deleteTo = {
              line: deleteLineNumber,
              ch: deleteRange.location + deleteRange.length + 1,
            }
            codeMirror.getDoc().markText(deleteFrom, deleteTo, {
              className: 'cm-diff-delete-inner',
            })
          }
        }
      }
    }
  }

  private onChanges = (cm: Editor) => {
    this.restoreScrollPosition(cm)

    const diff = this.props.diff
    if (diff.kind === DiffType.Text) {
      this.markIntraLineChanges(cm, diff)
    }
  }

  private onChangeImageDiffType = (type: ImageDiffType) => {
    this.props.dispatcher.changeImageDiffType(type)
  }

  private renderImage(imageDiff: IImageDiff) {
    if (imageDiff.current && imageDiff.previous) {
      return (
        <ModifiedImageDiff
          onChangeDiffType={this.onChangeImageDiffType}
          diffType={this.props.imageDiffType}
          current={imageDiff.current}
          previous={imageDiff.previous}
        />
      )
    }

    if (imageDiff.current && this.props.file.status === AppFileStatus.New) {
      return <NewImageDiff current={imageDiff.current} />
    }

    if (
      imageDiff.previous &&
      this.props.file.status === AppFileStatus.Deleted
    ) {
      return <DeletedImageDiff previous={imageDiff.previous} />
    }

    return null
  }

  private renderLargeTextDiff() {
    return (
      <div className="panel empty large-diff">
        <img src={NoDiffImage} />
        <p>
          The diff is too large to be displayed by default.
          <br />
          You can try to show it anyways, but performance may be negatively
          impacted.
        </p>
        <Button onClick={this.showLargeDiff}>
          {__DARWIN__ ? 'Show Diff' : 'Show diff'}
        </Button>
      </div>
    )
  }

  private renderUnrenderableDiff() {
    return (
      <div className="panel empty large-diff">
        <img src={NoDiffImage} />
        <p>The diff is too large to be displayed.</p>
      </div>
    )
  }

  private renderLargeText(diff: ILargeTextDiff) {
    // guaranteed to be set since this function won't be called if text or hunks are null
    const textDiff: ITextDiff = {
      text: diff.text!,
      hunks: diff.hunks!,
      kind: DiffType.Text,
      lineEndingsChange: diff.lineEndingsChange,
    }

    return this.renderTextDiff(textDiff)
  }

  private renderText(diff: ITextDiff) {
    if (diff.hunks.length === 0) {
      if (this.props.file.status === AppFileStatus.New) {
        return <div className="panel empty">The file is empty</div>
      }

      if (this.props.file.status === AppFileStatus.Renamed) {
        return (
          <div className="panel renamed">
            The file was renamed but not changed
          </div>
        )
      }

      return <div className="panel empty">No content changes found</div>
    }

    return this.renderTextDiff(diff)
  }

  private renderBinaryFile() {
    return (
      <BinaryFile
        path={this.props.file.path}
        repository={this.props.repository}
        dispatcher={this.props.dispatcher}
      />
    )
  }

  private renderTextDiff(diff: ITextDiff) {
    const options: IEditorConfigurationExtra = {
      lineNumbers: false,
      readOnly: true,
      showCursorWhenSelecting: false,
      cursorBlinkRate: -1,
      lineWrapping: true,
      mode: { name: DiffSyntaxMode.ModeName },
      // Make sure CodeMirror doesn't capture Tab and thus destroy tab navigation
      extraKeys: { Tab: false },
      scrollbarStyle: __DARWIN__ ? 'simple' : 'native',
      styleSelectedText: true,
      lineSeparator: '\n',
      specialChars: /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\ufeff]/,
    }

    // If the text looks like it could have been formatted using Windows
    // line endings (\r\n) we need to massage it a bit before we hand it
    // off to CodeMirror. That's because CodeMirror has two ways of splitting
    // lines, one is the built in which splits on \n, \r\n and \r. The last
    // one is important because that will match carriage return characters
    // inside a diff line. The other way is when consumers supply the
    // lineSeparator option. That option only takes a string meaning we can
    // either make it split on '\r\n', '\n' or '\r' but not what we would like
    // to do, namely '\r?\n'. We want to keep CR characters inside of a diff
    // line so that we can mark them using the specialChars attribute so
    // we convert all \r\n to \n and remove any trailing \r character.
    const text =
      diff.text.indexOf('\r') !== -1
        ? diff.text
            // Capture the \r if followed by (positive lookahead) a \n or
            // the end of the string. Note that this does not capture the \n.
            .replace(/\r(?=\n|$)/g, '')
        : diff.text

    return (
      <CodeMirrorHost
        className="diff-code-mirror"
        value={text}
        options={options}
        isSelectionEnabled={this.isSelectionEnabled}
        onChanges={this.onChanges}
        onRenderLine={this.renderLine}
        ref={this.getAndStoreCodeMirrorInstance}
        onCopy={this.onCopy}
      />
    )
  }

  private onCopy = (editor: CodeMirror.Editor, event: Event) => {
    event.preventDefault()

    // Remove the diff line markers from the copied text. The beginning of the
    // selection might start within a line, in which case we don't have to trim
    // the diff type marker. But for selections that span multiple lines, we'll
    // trim it.
    const doc = editor.getDoc()
    const lines = doc.getSelections()
    const selectionRanges = doc.listSelections()
    const lineContent: Array<string> = []

    for (let i = 0; i < lines.length; i++) {
      const range = selectionRanges[i]
      const content = lines[i]
      const contentLines = content.split('\n')
      for (const [i, line] of contentLines.entries()) {
        if (i === 0 && range.head.ch > 0) {
          lineContent.push(line)
        } else {
          lineContent.push(line.substr(1))
        }
      }

      const textWithoutMarkers = lineContent.join('\n')
      clipboard.writeText(textWithoutMarkers)
    }
  }

  private getAndStoreCodeMirrorInstance = (cmh: CodeMirrorHost | null) => {
    this.codeMirror = cmh === null ? null : cmh.getEditor()
  }

  private renderDiff(diff: IDiff): JSX.Element | null {
    switch (diff.kind) {
      case DiffType.Text:
        return this.renderText(diff)
      case DiffType.Binary:
        return this.renderBinaryFile()
      case DiffType.Image:
        return this.renderImage(diff)
      case DiffType.LargeText: {
        return this.state.forceShowLargeDiff
          ? this.renderLargeText(diff)
          : this.renderLargeTextDiff()
      }
      case DiffType.Unrenderable:
        return this.renderUnrenderableDiff()
      default:
        return assertNever(diff, `Unsupported diff type: ${diff}`)
    }
  }

  private showLargeDiff = () => {
    this.setState({ forceShowLargeDiff: true })
  }
}
