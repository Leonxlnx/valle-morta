"""Bone list shared by rigging, animation and export."""
from body import J

BONES = ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Jaw', 'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Hand.L',
         'Shoulder.R', 'UpperArm.R', 'LowerArm.R', 'Hand.R', 'UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'Toe.L',
         'UpperLeg.R', 'LowerLeg.R', 'Foot.R', 'Toe.R']
PARENT = [-1, 0, 1, 2, 3, 4, 2, 6, 7, 8, 2, 10, 11, 12, 0, 14, 15, 16, 0, 18, 19, 20]
TAIL = {'Hips': 'Spine', 'Spine': 'Chest', 'Chest': 'Neck', 'Neck': 'Head', 'Head': 'HeadTop', 'Jaw': 'JawTip',
        'Shoulder.L': 'UpperArm.L', 'UpperArm.L': 'LowerArm.L', 'LowerArm.L': 'Hand.L', 'Hand.L': 'HandTip.L',
        'Shoulder.R': 'UpperArm.R', 'UpperArm.R': 'LowerArm.R', 'LowerArm.R': 'Hand.R', 'Hand.R': 'HandTip.R',
        'UpperLeg.L': 'LowerLeg.L', 'LowerLeg.L': 'Foot.L', 'Foot.L': 'Toe.L', 'Toe.L': 'ToeTip.L',
        'UpperLeg.R': 'LowerLeg.R', 'LowerLeg.R': 'Foot.R', 'Foot.R': 'Toe.R', 'Toe.R': 'ToeTip.R'}
