//go:build windows

package pty

import (
	"fmt"
	"io"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
)

var (
	kernel32                              = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole               = kernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole               = kernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole                = kernel32.NewProc("ClosePseudoConsole")
	procInitializeProcThreadAttributeList = kernel32.NewProc("InitializeProcThreadAttributeList")
	procUpdateProcThreadAttribute         = kernel32.NewProc("UpdateProcThreadAttribute")
	procDeleteProcThreadAttributeList     = kernel32.NewProc("DeleteProcThreadAttributeList")
)

type coord struct {
	X int16
	Y int16
}

type startupInfoEx struct {
	windows.StartupInfo
	attributeList *byte
}

type pseudoConsole windows.Handle

type Session struct {
	input     *os.File
	output    *os.File
	process   windows.Handle
	thread    windows.Handle
	console   pseudoConsole
	processID uint32
}

func Start(shell string) (*Session, error) {
	inRead, inWrite, err := createPipePair()
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(inRead)
	defer windows.CloseHandle(inWrite)

	outRead, outWrite, err := createPipePair()
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(outRead)
	defer windows.CloseHandle(outWrite)

	console, err := createPseudoConsole(inRead, outWrite)
	if err != nil {
		return nil, err
	}

	attrList, cleanupAttrList, err := newAttributeList(console)
	if err != nil {
		closePseudoConsole(console)
		return nil, err
	}
	defer cleanupAttrList()

	var siEx startupInfoEx
	siEx.Cb = uint32(unsafe.Sizeof(siEx))
	siEx.attributeList = attrList

	var pi windows.ProcessInformation
	commandLine, err := windows.UTF16PtrFromString(quotedCommand(shell))
	if err != nil {
		closePseudoConsole(console)
		return nil, err
	}

	if err := windows.CreateProcess(
		nil,
		commandLine,
		nil,
		nil,
		false,
		extendedStartupInfoPresent,
		nil,
		nil,
		&siEx.StartupInfo,
		&pi,
	); err != nil {
		closePseudoConsole(console)
		return nil, err
	}

	return &Session{
		input:     os.NewFile(uintptr(inWrite), "conpty-input"),
		output:    os.NewFile(uintptr(outRead), "conpty-output"),
		process:   pi.Process,
		thread:    pi.Thread,
		console:   console,
		processID: pi.ProcessId,
	}, nil
}

func (s *Session) Read(p []byte) (int, error) {
	return s.output.Read(p)
}

func (s *Session) Write(p []byte) (int, error) {
	return s.input.Write(p)
}

func (s *Session) Resize(cols, rows uint16) error {
	r1, _, callErr := procResizePseudoConsole.Call(
		uintptr(s.console),
		uintptr(*(*uint32)(unsafe.Pointer(&coord{
			X: int16(cols),
			Y: int16(rows),
		}))),
	)
	if r1 != 0 {
		return windows.Errno(r1)
	}
	if callErr != windows.ERROR_SUCCESS && callErr != nil {
		return callErr
	}
	return nil
}

func (s *Session) Wait() error {
	if _, err := windows.WaitForSingleObject(s.process, windows.INFINITE); err != nil {
		return err
	}

	var exitCode uint32
	if err := windows.GetExitCodeProcess(s.process, &exitCode); err != nil {
		return err
	}
	if exitCode != 0 {
		return fmt.Errorf("process exited with code %d", exitCode)
	}
	return io.EOF
}

func (s *Session) Close() error {
	var errs []string
	if s.input != nil {
		if err := s.input.Close(); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if s.output != nil {
		if err := s.output.Close(); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if s.thread != 0 {
		if err := windows.CloseHandle(s.thread); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if s.process != 0 {
		if err := windows.CloseHandle(s.process); err != nil {
			errs = append(errs, err.Error())
		}
	}
	if s.console != 0 {
		closePseudoConsole(s.console)
	}
	if len(errs) > 0 {
		return fmt.Errorf(strings.Join(errs, "; "))
	}
	return nil
}

func createPipePair() (windows.Handle, windows.Handle, error) {
	var readPipe windows.Handle
	var writePipe windows.Handle
	if err := windows.CreatePipe(&readPipe, &writePipe, nil, 0); err != nil {
		return 0, 0, err
	}
	return readPipe, writePipe, nil
}

func createPseudoConsole(inputRead windows.Handle, outputWrite windows.Handle) (pseudoConsole, error) {
	var console pseudoConsole
	size := coord{X: 120, Y: 30}
	r1, _, callErr := procCreatePseudoConsole.Call(
		uintptr(*(*uint32)(unsafe.Pointer(&size))),
		uintptr(inputRead),
		uintptr(outputWrite),
		0,
		uintptr(unsafe.Pointer(&console)),
	)
	if r1 != 0 {
		return 0, windows.Errno(r1)
	}
	if callErr != windows.ERROR_SUCCESS && callErr != nil {
		return 0, callErr
	}
	return console, nil
}

func closePseudoConsole(console pseudoConsole) {
	procClosePseudoConsole.Call(uintptr(console))
}

func newAttributeList(console pseudoConsole) (*byte, func(), error) {
	var size uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size)))
	buffer := make([]byte, size)
	attrList := &buffer[0]

	r1, _, callErr := procInitializeProcThreadAttributeList.Call(
		uintptr(unsafe.Pointer(attrList)),
		1,
		0,
		uintptr(unsafe.Pointer(&size)),
	)
	if r1 == 0 {
		return nil, nil, callErr
	}

	r1, _, callErr = procUpdateProcThreadAttribute.Call(
		uintptr(unsafe.Pointer(attrList)),
		0,
		procThreadAttributePseudoConsole,
		uintptr(console),
		unsafe.Sizeof(console),
		0,
		0,
	)
	if r1 == 0 {
		procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(attrList)))
		return nil, nil, callErr
	}

	return attrList, func() {
		procDeleteProcThreadAttributeList.Call(uintptr(unsafe.Pointer(attrList)))
	}, nil
}

func quotedCommand(shell string) string {
	if strings.ContainsAny(shell, " \t") {
		return `"` + shell + `"`
	}
	return shell
}
